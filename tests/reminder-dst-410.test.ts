// 提醒循环的夏令时漂移：daily/weekly 以前用固定 86_400_000ms 推进，跨 DST 会漂一小时。
// 这里把进程时区钉在欧洲/柏林（有夏令时；本机是中国标准时间，测不出这个缺陷），
// 用真实的本地 Date 构造，不依赖跑测试这台机器所在时区。
// @vitest-environment node
import { describe, it, expect, afterAll, vi } from 'vitest'

// reminder.repo → database → portable 会摸 electron.app；这里只测纯函数，不落盘
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const ORIGINAL_TZ = process.env.TZ
process.env.TZ = 'Europe/Berlin'

import { computeNextFireAt } from '../src/main/db/repositories/reminder.repo'
import type { ReminderRepeatRule } from '../src/shared/types'

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

/** 本地时间构造（TZ=Europe/Berlin 时即柏林墙上时间） */
const local = (y: number, m: number, d: number, h = 9, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

const DAILY1: ReminderRepeatRule = { kind: 'daily', intervalDays: 1 }
const WEEKLY_SUNDAY: ReminderRepeatRule = { kind: 'weekly', weekdays: [7] }

describe('computeNextFireAt — 跨夏令时按本地日历日推进', () => {
  it('欧洲/柏林春季前跳（2024-03-31 02:00→03:00）：本地钟点不变，间隔 23h 不是 24h', () => {
    const prev = local(2024, 3, 30, 9) // CET(UTC+1)
    const next = computeNextFireAt(prev, DAILY1, prev)
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getDate()).toBe(31)
    // 旧实现 +24h 会落到本地 10:00；日历推进应是 23h
    expect(next - prev).toBe(23 * 3600 * 1000)
    expect(new Date(next).getTimezoneOffset()).not.toBe(new Date(prev).getTimezoneOffset())
  })

  it('欧洲/柏林秋季回拨（2024-10-27 03:00→02:00）：本地钟点不变，间隔 25h', () => {
    const prev = local(2024, 10, 26, 9) // CEST(UTC+2)
    const next = computeNextFireAt(prev, DAILY1, prev)
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getDate()).toBe(27)
    expect(next - prev).toBe(25 * 3600 * 1000)
  })

  it('weekly 跨春季前跳：仍落在周日的同一本地钟点（间隔 167h）', () => {
    const prev = local(2024, 3, 24, 9) // 周日
    expect(new Date(prev).getDay()).toBe(0)
    const next = computeNextFireAt(prev, WEEKLY_SUNDAY, prev)
    expect(new Date(next).getDay()).toBe(0)
    expect(new Date(next).getHours()).toBe(9)
    expect(next - prev).toBe(167 * 3600 * 1000)
  })

  it('错过很久时追平到 now 之后（只晚不早），且每一步本地钟点不变、绝对时间单调递增', () => {
    const prev = local(2024, 3, 1, 9)
    const now = local(2024, 4, 10, 12)
    const next = computeNextFireAt(prev, DAILY1, now)
    expect(next).toBeGreaterThan(now)
    expect(new Date(next).getHours()).toBe(9)

    // 连续推进 8 次（横跨春秋两个 DST 边界）：严格递增、从不回退、钟点始终 9
    let cur = next
    for (let i = 0; i < 8; i++) {
      const following = computeNextFireAt(cur, DAILY1, cur)
      expect(following).toBeGreaterThan(cur)
      expect(new Date(following).getHours()).toBe(9)
      cur = following
    }
  })

  it('now 已经越过候选时也不交出过去时刻（§332 口径不变）', () => {
    const prev = local(2024, 3, 30, 9)
    const now = local(2024, 4, 2, 10)
    const next = computeNextFireAt(prev, DAILY1, now)
    expect(next).toBeGreaterThan(now)
    expect(new Date(next).getHours()).toBe(9)
    expect(new Date(next).getDate()).toBe(3)
  })
})
