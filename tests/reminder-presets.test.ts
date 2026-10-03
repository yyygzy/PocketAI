// 消息右键提醒预设纯函数测试：分钟夹取、09:00 计算、偏移、文本清洗截断
import { describe, it, expect } from 'vitest'
import {
  clampReminderMinutes,
  nextNineAm,
  buildReminderPresets,
  buildReminderText
} from '../src/renderer/src/utils/reminder-presets'
import { MAX_REMINDER_MINUTES } from '../src/shared/schemas/reminder'

const MIN = 60_000

describe('clampReminderMinutes', () => {
  it('夹到 1–43200 边界', () => {
    expect(clampReminderMinutes(0)).toBe(1)
    expect(clampReminderMinutes(-100)).toBe(1)
    expect(clampReminderMinutes(1)).toBe(1)
    expect(clampReminderMinutes(MAX_REMINDER_MINUTES)).toBe(MAX_REMINDER_MINUTES)
    expect(clampReminderMinutes(MAX_REMINDER_MINUTES + 5)).toBe(MAX_REMINDER_MINUTES)
  })
  it('小数向下取整；NaN/Infinity 归 1', () => {
    expect(clampReminderMinutes(12.9)).toBe(12)
    expect(clampReminderMinutes(Number.NaN)).toBe(1)
    expect(clampReminderMinutes(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('nextNineAm', () => {
  it('当天 09:00 未过 → 今天 09:00', () => {
    const now = new Date(2026, 9, 3, 8, 30, 0)
    const r = new Date(nextNineAm(now))
    expect(r.getFullYear()).toBe(2026)
    expect(r.getMonth()).toBe(9)
    expect(r.getDate()).toBe(3)
    expect(r.getHours()).toBe(9)
    expect(r.getMinutes()).toBe(0)
  })
  it('10:00 / 正好 09:00 → 次日 09:00', () => {
    const late = new Date(2026, 9, 3, 10, 0, 0)
    const r1 = new Date(nextNineAm(late))
    expect(r1.getDate()).toBe(4)
    expect(r1.getHours()).toBe(9)

    const sharp = new Date(2026, 9, 3, 9, 0, 0)
    const r2 = new Date(nextNineAm(sharp))
    expect(r2.getDate()).toBe(4)
  })
})

describe('buildReminderPresets', () => {
  it('4 个预设 key 完整且偏移正确（15m/1h/3h/next9am 均晚于 now 且 ≤30 天）', () => {
    const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
    const ps = buildReminderPresets(now)
    expect(ps.map((p) => p.key)).toEqual(['in15m', 'in1h', 'in3h', 'next9am'])
    expect(ps[0]!.fireAt).toBe(now + 15 * MIN)
    expect(ps[1]!.fireAt).toBe(now + 60 * MIN)
    expect(ps[2]!.fireAt).toBe(now + 180 * MIN)
    const nine = new Date(ps[3]!.fireAt)
    expect(nine.getHours()).toBe(9)
    for (const p of ps) {
      expect(p.fireAt).toBeGreaterThan(now)
      expect(p.fireAt).toBeLessThanOrEqual(now + MAX_REMINDER_MINUTES * MIN)
    }
  })
})

describe('buildReminderText', () => {
  it('折叠空白与去 markdown 符号', () => {
    expect(buildReminderText('# 标题\n\n正文  **粗体**  [链接](u)')).toBe('标题 正文 粗体 链接')
    expect(buildReminderText('  多行\n  文本 \t ')).toBe('多行 文本')
  })
  it('代码块整体折叠为空格', () => {
    expect(buildReminderText('前\n```js\nconst x=1\n```\n后')).toBe('前 后')
  })
  it('截断到 200 字', () => {
    expect(buildReminderText('a'.repeat(500))).toHaveLength(200)
  })
  it('纯空白返回空串（供调用方提示无文本）', () => {
    expect(buildReminderText('   \n\t')).toBe('')
  })
})
