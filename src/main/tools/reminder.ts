// reminder 内置工具：一次性定时提醒（set/list/cancel）。
// 时间换算全部在主进程完成（Date.now/Date.parse），LLM 只需传相对分钟数或 ISO 字符串，
// 避免小模型时区换算错误。落库后由 main/reminder/scheduler 扫描到点触发系统通知。
import type { BuiltinTool } from './builtin'
import { reminderRepo } from '../db/repositories/reminder.repo'

const MAX_PENDING = 50
const MIN_MINUTES = 1
const MAX_MINUTES = 43_200 // 30 天

function formatLocal(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export const reminderSetTool: BuiltinTool = {
  schema: {
    id: 'reminder.set',
    name: 'reminder_set',
    description:
      '设置一次性定时提醒，到点系统通知。参数：text (string，提醒内容)；时间二选一——in_minutes (number, 1-43200，N 分钟后，优先使用) 或 at (string, ISO 8601 绝对时间，如 2026-09-27T15:00:00)。若用户说的是「明天下午3点」这类绝对时间，先调 time_now 确认当前时间再换算。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容，如「开会」「喝水」' },
        in_minutes: { type: 'number', description: '多少分钟后触发（1-43200），优先用这个' },
        at: { type: 'string', description: 'ISO 8601 绝对触发时间（与 in_minutes 二选一）' }
      },
      required: ['text'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 3_000
  },
  async execute(args, ctx) {
    const text = typeof args?.text === 'string' ? args.text.trim() : ''
    if (!text) throw new Error('text 不能为空')

    const hasMinutes = typeof args?.in_minutes === 'number' && Number.isFinite(args.in_minutes)
    const hasAt = typeof args?.at === 'string' && args.at.trim().length > 0
    if (hasMinutes === hasAt) throw new Error('in_minutes 与 at 必须且只能提供一个')

    let fireAt: number
    if (hasMinutes) {
      const m = Math.floor(args!.in_minutes as number)
      if (m < MIN_MINUTES || m > MAX_MINUTES)
        throw new Error(`in_minutes 需在 ${MIN_MINUTES}-${MAX_MINUTES} 之间（最长 30 天）`)
      fireAt = Date.now() + m * 60_000
    } else {
      fireAt = Date.parse((args!.at as string).trim())
      if (!Number.isFinite(fireAt)) throw new Error('at 不是有效的 ISO 8601 时间')
    }
    if (fireAt <= Date.now()) throw new Error('触发时间必须晚于当前时间')

    if (reminderRepo.countPending() >= MAX_PENDING)
      throw new Error(`待触发提醒已达上限 ${MAX_PENDING} 条，请先 reminder_cancel 清理`)

    const rec = reminderRepo.create(text, fireAt, ctx?.agent?.conversationId ?? null)
    return JSON.stringify({ ok: true, id: rec.id, text: rec.text, fireAt: rec.fireAt, fireAtLocal: formatLocal(rec.fireAt) })
  }
}

export const reminderListTool: BuiltinTool = {
  schema: {
    id: 'reminder.list',
    name: 'reminder_list',
    description:
      '查看提醒列表。参数：status (string, 可选，pending/fired/cancelled/missed，默认 pending)，limit (number, 可选，默认 20，最大 50)。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending | fired | cancelled | missed，默认 pending' },
        limit: { type: 'number', description: '返回条数上限（1-50，默认 20）' }
      },
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 3_000
  },
  async execute(args) {
    const status = typeof args?.status === 'string' && args.status.trim() ? args.status.trim() : 'pending'
    if (!['pending', 'fired', 'cancelled', 'missed'].includes(status))
      throw new Error('status 必须是 pending/fired/cancelled/missed 之一')
    const limit = Math.min(50, Math.max(1, Math.floor(Number(args?.limit) || 20)))
    const list = reminderRepo.listByStatus(status as 'pending' | 'fired' | 'cancelled' | 'missed', limit)
    return JSON.stringify({
      count: list.length,
      reminders: list.map((r) => ({
        id: r.id,
        text: r.text,
        fireAt: r.fireAt,
        fireAtLocal: formatLocal(r.fireAt),
        status: r.status
      }))
    })
  }
}

export const reminderCancelTool: BuiltinTool = {
  schema: {
    id: 'reminder.cancel',
    name: 'reminder_cancel',
    description: '取消一条待触发的提醒（仅 pending 状态可取消）。参数：id (string，reminder_list 返回的 id)。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要取消的提醒 id' }
      },
      required: ['id'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 3_000
  },
  async execute(args) {
    const id = typeof args?.id === 'string' ? args.id.trim() : ''
    if (!id) throw new Error('id 不能为空')
    const ok = reminderRepo.cancel(id)
    if (!ok) throw new Error('取消失败：提醒不存在或已触发/已取消')
    return JSON.stringify({ ok: true, id, remaining: reminderRepo.countPending() })
  }
}
