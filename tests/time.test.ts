import { describe, it, expect } from 'vitest'
import { formatDateTime, fileTimestamp, daySeparatorLabel, isDifferentDay } from '../src/renderer/src/utils/time'

// 固定「现在」：2026-10-02 14:30:00 本地
const NOW = new Date(2026, 9, 2, 14, 30, 0).getTime()

const t = (k: string, p?: Record<string, string | number>) => {
  if (k === 'chat.dateSepDate') return `${p!.m}/${p!.d}`
  return k
}

describe('time utils', () => {
  it('formatDateTime 输出 YYYY-MM-DD HH:mm 补零', () => {
    expect(formatDateTime(new Date(2026, 0, 5, 9, 5).getTime())).toBe('2026-01-05 09:05')
    expect(formatDateTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31 23:59')
  })

  it('fileTimestamp 无空格无冒号', () => {
    const s = fileTimestamp(new Date(2026, 9, 2, 14, 30).getTime())
    expect(s).toBe('20261002-1430')
    expect(s).not.toMatch(/[\s:]/)
  })

  it('daySeparatorLabel 今天/昨天/更早', () => {
    const today = new Date(2026, 9, 2, 8, 0).getTime()
    const yesterday = new Date(2026, 9, 1, 20, 0).getTime()
    const older = new Date(2026, 8, 15, 12, 0).getTime()
    expect(daySeparatorLabel(today, t, NOW)).toBe('chat.dateSepToday')
    expect(daySeparatorLabel(yesterday, t, NOW)).toBe('chat.dateSepYesterday')
    expect(daySeparatorLabel(older, t, NOW)).toBe('9/15')
  })

  it('isDifferentDay 跨年/跨月正确', () => {
    expect(isDifferentDay(new Date(2026, 0, 1, 23, 59).getTime(), new Date(2026, 0, 2, 0, 1).getTime())).toBe(true)
    expect(isDifferentDay(new Date(2026, 0, 1, 10, 0).getTime(), new Date(2026, 0, 1, 23, 59).getTime())).toBe(false)
  })
})
