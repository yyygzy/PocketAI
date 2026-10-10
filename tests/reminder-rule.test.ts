// 循环规则 → 可读徽标（纯函数，词条由调用方注入）
import { describe, it, expect } from 'vitest'
import { normalizeWeekdays, repeatRuleLabel } from '../src/shared/reminder-rule'
import type { ReminderRepeatRule } from '../src/shared/types'

const words = {
  daily: (n: number) => `每 ${n} 天`,
  weekly: (days: string) => `每${days}`,
  monthly: (n: number) => `每月 ${n} 号`,
  weekday: (n: number) => ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][n - 1] ?? `?${n}`,
  separator: '、'
}

describe('normalizeWeekdays', () => {
  it('升序去重', () => {
    expect(normalizeWeekdays([3, 1, 3, 2])).toEqual([1, 2, 3])
  })
  it('丢弃非整数与越界值（DB 里是 JSON，历史脏数据不能让徽标出「周0」「周9」）', () => {
    expect(normalizeWeekdays([0, 1, 7, 8, -1, 2.5, Number.NaN])).toEqual([1, 7])
  })
  it('空数组返回空', () => {
    expect(normalizeWeekdays([])).toEqual([])
  })
})

describe('repeatRuleLabel', () => {
  it('一次性提醒（null/undefined）返回空串', () => {
    expect(repeatRuleLabel(null, words)).toBe('')
    expect(repeatRuleLabel(undefined, words)).toBe('')
  })
  it('daily 带间隔', () => {
    const rule: ReminderRepeatRule = { kind: 'daily', intervalDays: 3 }
    expect(repeatRuleLabel(rule, words)).toBe('每 3 天')
  })
  it('monthly 带号数', () => {
    const rule: ReminderRepeatRule = { kind: 'monthly', dayOfMonth: 15 }
    expect(repeatRuleLabel(rule, words)).toBe('每月 15 号')
  })
  it('weekly 多日按升序拼接', () => {
    const rule: ReminderRepeatRule = { kind: 'weekly', weekdays: [3, 1] }
    expect(repeatRuleLabel(rule, words)).toBe('每周一、周三')
  })
  it('weekly 全是脏值时不给半截话（只写「每」）', () => {
    const rule: ReminderRepeatRule = { kind: 'weekly', weekdays: [0, 9] }
    expect(repeatRuleLabel(rule, words)).toBe('')
  })
})
