// 消息右键「提醒我」预设纯函数（时间换算在渲染端按用户本地时区；主进程仍二次校验范围）。
import { MAX_REMINDER_MINUTES } from '../../../shared/schemas/reminder'
import type { ReminderRepeatRule } from '../../../shared/types'

export type ReminderPresetKey =
  | 'in15m'
  | 'in1h'
  | 'in3h'
  | 'next9am'
  | 'every9am'
  | 'everyMon9am'
  | 'everyMonth1st'

export interface ReminderPreset {
  key: ReminderPresetKey
  fireAt: number
  /** 循环规则（无=一次性） */
  repeatRule?: ReminderRepeatRule
}

const MINUTE = 60_000

/** 自定义分钟夹取到 1–43200（30 天），非有限值/NaN 归 1 */
export function clampReminderMinutes(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(MAX_REMINDER_MINUTES, Math.max(1, Math.floor(v)))
}

/** 下一个本地时间 09:00 的 epoch：今天 09:00 已过（含正好 09:00:00，留出创建耗时）则取明天 */
export function nextNineAm(now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(9, 0, 0, 0)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 下一个本地时间 周一 09:00 的 epoch：今天周一且未到 09:00 取今日，否则取下一周一 */
export function nextMondayNineAm(now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(9, 0, 0, 0)
  // 周一=1（JS getDay 周日=0）
  const day = d.getDay()
  const offset = day === 1 ? (d.getTime() <= now.getTime() ? 7 : 0) : ((8 - day) % 7)
  d.setDate(d.getDate() + offset)
  return d.getTime()
}

/** 下一个本地时间 月 1 号 09:00 的 epoch：今天 1 号且未到 09:00 取今日，否则取下一月 1 号 */
export function nextMonthFirstNineAm(now: Date = new Date()): number {
  const d = new Date(now)
  d.setHours(9, 0, 0, 0)
  if (d.getDate() === 1 && d.getTime() > now.getTime()) return d.getTime()
  // 切到下一月 1 号
  const next = new Date(d)
  next.setMonth(next.getMonth() + 1, 1)
  next.setHours(9, 0, 0, 0)
  return next.getTime()
}

/** 7 个预设：15 分钟 / 1 小时 / 3 小时 / 下一个 09:00（一次性）+ 每天/每周一/每月1号 09:00（循环） */
export function buildReminderPresets(now: number = Date.now()): ReminderPreset[] {
  const d = new Date(now)
  return [
    { key: 'in15m', fireAt: now + 15 * MINUTE },
    { key: 'in1h', fireAt: now + 60 * MINUTE },
    { key: 'in3h', fireAt: now + 180 * MINUTE },
    { key: 'next9am', fireAt: nextNineAm(d) },
    { key: 'every9am', fireAt: nextNineAm(d), repeatRule: { kind: 'daily', intervalDays: 1 } },
    { key: 'everyMon9am', fireAt: nextMondayNineAm(d), repeatRule: { kind: 'weekly', weekdays: [1] } },
    { key: 'everyMonth1st', fireAt: nextMonthFirstNineAm(d), repeatRule: { kind: 'monthly', dayOfMonth: 1 } }
  ]
}

/** 从消息正文生成提醒文本：折叠空白、去 markdown 标记、截 200 字 */
export function buildReminderText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片：保留 alt 文本
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接：保留链接文字、丢 URL
    .replace(/[#>*`_~\-[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
