// 循环提醒规则 → 可读文案（纯函数，词条由调用方注入，方便测试与四语复用）
//
// 规则本身是数据（daily/weekly/monthly），文案要跟着语言走，所以这里只产出结构：
// 星期几先去重、剔除越界值、升序排列，再交给调用方拼成「每周一、周三」。
import type { ReminderRepeatRule } from './types'

/** JS getDay 体系：周日=0，本项目的 weekly 规则约定周一=1 … 周日=7 */
export const WEEKDAY_MIN = 1
export const WEEKDAY_MAX = 7

export interface RepeatRuleWords {
  /** 每 {n} 天 */
  daily: (intervalDays: number) => string
  /** 每 {days}（days 已是「周一、周三」这种成品串） */
  weekly: (days: string) => string
  /** 每月 {n} 号 */
  monthly: (dayOfMonth: number) => string
  /** 单个星期几的名字 */
  weekday: (weekday: number) => string
  /** 星期几之间的分隔符（中日顿号、英韩逗号） */
  separator: string
}

/** 去重 + 丢弃非 1–7 的脏值 + 升序（DB 里是 JSON 数组，历史数据可能有重复或越界） */
export function normalizeWeekdays(weekdays: readonly number[]): number[] {
  const valid = weekdays.filter(
    (w) => Number.isInteger(w) && w >= WEEKDAY_MIN && w <= WEEKDAY_MAX
  )
  return [...new Set(valid)].sort((a, b) => a - b)
}

/**
 * 规则 → 徽标文案；一次性提醒（null/undefined）返回空串，调用方据此不渲染徽标。
 * weekly 的星期全非法时也返回空串，避免出现「每」这种半截话。
 */
export function repeatRuleLabel(
  rule: ReminderRepeatRule | null | undefined,
  words: RepeatRuleWords
): string {
  if (!rule) return ''
  if (rule.kind === 'daily') return words.daily(rule.intervalDays)
  if (rule.kind === 'monthly') return words.monthly(rule.dayOfMonth)
  const days = normalizeWeekdays(rule.weekdays).map(words.weekday).join(words.separator)
  return days === '' ? '' : words.weekly(days)
}
