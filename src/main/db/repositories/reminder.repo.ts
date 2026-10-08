// 定时提醒数据访问（Agent reminder_set/list/cancel 内置工具读写 + reminder scheduler 扫描触发）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import {
  reminderTextSchema,
  reminderIdSchema,
  reminderStatusSchema,
} from '../../../shared/schemas/reminder'
import type { ReminderRecord, ReminderRepeatRule, ReminderStatus } from '../../../shared/types'

interface ReminderRow {
  id: string
  text: string | null
  fire_at: number
  status: string | null
  conversation_id: string | null
  created_at: number
  repeat_rule: string | null
}

/** 解析 repeat_rule JSON 容错：坏 JSON/非对象 → undefined；仅放行合法 daily/weekly/monthly */
function parseRepeatRule(raw: string | null): ReminderRepeatRule | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return undefined
    const r = v as Record<string, unknown>
    if (r.kind === 'daily' && typeof r.intervalDays === 'number') {
      return { kind: 'daily', intervalDays: r.intervalDays }
    }
    if (r.kind === 'weekly' && Array.isArray(r.weekdays)) {
      return { kind: 'weekly', weekdays: r.weekdays.filter((d) => typeof d === 'number') as number[] }
    }
    if (r.kind === 'monthly' && typeof r.dayOfMonth === 'number') {
      return { kind: 'monthly', dayOfMonth: r.dayOfMonth }
    }
    return undefined
  } catch {
    return undefined
  }
}

function rowToRecord(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    text: row.text ?? '',
    fireAt: row.fire_at,
    status: (row.status as ReminderStatus) ?? 'pending',
    conversationId: row.conversation_id ?? null,
    createdAt: row.created_at,
    repeatRule: parseRepeatRule(row.repeat_rule),
  }
}

/** 计算下一次循环触发时间（epoch ms）：
 * - daily: prevFireAt + intervalDays 天
 * - weekly: 找 prevFireAt 之后的下一个匹配 weekday
 * - monthly: 下一自然月的 dayOfMonth（不存在则取该月最后一天）
 * 若新时间仍 ≤ now（时区/夏令时边界）则继续递推直到 > now（上限 8 次防死循环） */
export function computeNextFireAt(prevFireAt: number, rule: ReminderRepeatRule, now: number): number {
  if (rule.kind === 'daily') {
    return prevFireAt + rule.intervalDays * 86_400_000
  }
  if (rule.kind === 'weekly') {
    const days = rule.weekdays
    if (days.length === 0) return prevFireAt + 7 * 86_400_000
    const base = new Date(prevFireAt)
    for (let i = 1; i <= 7; i++) {
      const d = new Date(base.getTime() + i * 86_400_000)
      const dow = ((d.getDay() + 6) % 7) + 1 // 周一=1 ... 周日=7
      if (days.includes(dow)) return d.getTime()
    }
    return prevFireAt + 7 * 86_400_000
  }
  // monthly: 下一自然月 dayOfMonth（不存在则取月末）
  const base = new Date(prevFireAt)
  const y = base.getFullYear()
  const m = base.getMonth()
  const targetDay = Math.min(rule.dayOfMonth, 28) // 先取安全值
  // 下一月 dayOfMonth；不存在则取该月最后一天
  const nextMonth = new Date(y, m + 1, targetDay, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds())
  // 若 dayOfMonth 超过下一月天数，Date 构造会溢出到下下月，回退到下一月最后一天
  const expectedMonth = m + 1
  if (nextMonth.getMonth() !== expectedMonth) {
    // 溢出：回退到 expectedMonth 的最后一天
    const lastDay = new Date(y, expectedMonth + 1, 0)
    lastDay.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds())
    return lastDay.getTime()
  }
  let result = nextMonth.getTime()
  // 防御：若新时间仍 ≤ now（极端边界），继续递推（上限 8 次）
  let guard = 0
  while (result <= now && guard < 8) {
    const n = new Date(result)
    const ny = n.getFullYear()
    const nm = n.getMonth()
    const nNext = new Date(ny, nm + 1, targetDay, n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds())
    if (nNext.getMonth() !== nm + 1) {
      const lastDay = new Date(ny, nm + 2, 0)
      lastDay.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), n.getMilliseconds())
      result = lastDay.getTime()
    } else {
      result = nNext.getTime()
    }
    guard++
  }
  return result
}

export const reminderRepo = {
  create(
    text: string,
    fireAt: number,
    conversationId?: string | null,
    repeatRule?: ReminderRepeatRule
  ): ReminderRecord {
    const parsedText = reminderTextSchema.parse(text)
    const now = Date.now()
    const id = randomUUID()
    const ruleJson = repeatRule ? JSON.stringify(repeatRule) : null
    dbService
      .getHandle()
      .prepare(
        'INSERT INTO reminders (id, text, fire_at, status, conversation_id, created_at, repeat_rule) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, parsedText, fireAt, 'pending', conversationId ?? null, now, ruleJson)
    return this.get(id)!
  },

  get(id: string): ReminderRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE id=?')
      .get(reminderIdSchema.parse(id)) as ReminderRow | undefined
    return row ? rowToRecord(row) : null
  },

  listPending(limit = 50): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? ORDER BY fire_at ASC LIMIT ?')
      .all('pending', limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  listByStatus(status: ReminderStatus, limit = 50): ReminderRecord[] {
    reminderStatusSchema.parse(status)
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? ORDER BY fire_at DESC LIMIT ?')
      .all(status, limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  /** 历史（已触发/已错过/已取消）：到期时间倒序，上限 50（提醒中心历史 tab） */
  listHistory(limit = 50): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare(
        "SELECT * FROM reminders WHERE status IN ('fired','missed','cancelled') ORDER BY fire_at DESC LIMIT ?"
      )
      .all(limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  listDue(now: number): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? AND fire_at<=? ORDER BY fire_at ASC')
      .all('pending', now) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  markFired(id: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=? WHERE id=?')
      .run('fired', reminderIdSchema.parse(id))
  },

  markMissed(id: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=? WHERE id=?')
      .run('missed', reminderIdSchema.parse(id))
  },

  /** 循环提醒到点重排：UPDATE fire_at 与 repeat_rule，状态保持 pending（不新建记录） */
  scheduleNext(id: string, fireAt: number, rule: ReminderRepeatRule): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=?, fire_at=?, repeat_rule=? WHERE id=?')
      .run('pending', fireAt, JSON.stringify(rule), reminderIdSchema.parse(id))
  },

  /** 历史 tab「重新安排」：missed/cancelled/fired 行重置 pending，可选改循环规则 */
  reschedule(id: string, fireAt: number, rule?: ReminderRepeatRule): boolean {
    const info = dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=?, fire_at=?, repeat_rule=? WHERE id=?')
      .run(
        'pending',
        fireAt,
        rule ? JSON.stringify(rule) : null,
        reminderIdSchema.parse(id)
      )
    return info.changes > 0
  },

  /** 编辑 pending 行：动态拼 UPDATE，仅 pending 状态可改（防终态行被改）；
   *  repeatRule: undefined=不改字段，null=清除变一次性，对象=改循环规则 */
  update(
    id: string,
    fields: { text?: string; fireAt?: number; repeatRule?: ReminderRepeatRule | null }
  ): boolean {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (fields.text !== undefined) {
      sets.push('text=?')
      params.push(reminderTextSchema.parse(fields.text))
    }
    if (fields.fireAt !== undefined) {
      sets.push('fire_at=?')
      params.push(fields.fireAt)
    }
    if (fields.repeatRule !== undefined) {
      sets.push('repeat_rule=?')
      params.push(fields.repeatRule ? JSON.stringify(fields.repeatRule) : null)
    }
    if (sets.length === 0) return false
    params.push(reminderIdSchema.parse(id))
    const info = dbService
      .getHandle()
      .prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id=? AND status='pending'`)
      .run(...params)
    return info.changes > 0
  },

  /** 一键重新安排 missed 循环提醒：按原 rule 用 computeNextFireAt 重算下次触发回 pending。
   *  一次性 missed（无 repeatRule）不支持，返回 ok=false 由前端引导用户新建 */
  rescheduleNext(id: string): { ok: boolean; fireAt?: number } {
    const rec = this.get(reminderIdSchema.parse(id))
    if (!rec || !rec.repeatRule) return { ok: false }
    const next = computeNextFireAt(rec.fireAt, rec.repeatRule, Date.now())
    const ok = this.reschedule(rec.id, next, rec.repeatRule)
    return ok ? { ok: true, fireAt: next } : { ok: false }
  },

  cancel(id: string): boolean {
    const info = dbService
      .getHandle()
      .prepare("UPDATE reminders SET status='cancelled' WHERE id=? AND status='pending'")
      .run(reminderIdSchema.parse(id))
    return info.changes > 0
  },

  countPending(): number {
    const row = dbService
      .getHandle()
      .prepare("SELECT COUNT(*) AS n FROM reminders WHERE status='pending'")
      .get() as { n: number } | undefined
    return row?.n ?? 0
  },
}
