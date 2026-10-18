// reminder scheduler 单元测试：到期触发 / 重启 missed 恢复 / 锁屏 DB 关闭容错 / 锁屏期间整轮暂缓
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const {
  notificationShowMock, notificationCtorMock, broadcastMock,
  listDueMock, markFiredMock, markMissedMock, scheduleNextMock,
  logInfoMock, logDebugMock
} =
  vi.hoisted(() => ({
    notificationShowMock: vi.fn(),
    notificationCtorMock: vi.fn(),
    broadcastMock: vi.fn(),
    listDueMock: vi.fn<() => unknown[]>(() => []),
    markFiredMock: vi.fn(),
    markMissedMock: vi.fn(),
    scheduleNextMock: vi.fn(),
    logInfoMock: vi.fn(),
    logDebugMock: vi.fn()
  }))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    constructor(opts: unknown) {
      notificationCtorMock(opts)
    }
    show(): void {
      notificationShowMock()
    }
  }
}))

vi.mock('../src/main/ipc/broadcast', () => ({ broadcast: broadcastMock }))
// 日志只收句柄：那两句"暂缓/补发"的判据要在用例里读，不该往控制台刷
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: logDebugMock,
    info: logInfoMock,
    warn: vi.fn(),
    error: vi.fn()
  })
}))
// DB 句柄整体打桩：调度器用例只该看到方法调用，真碰库就是接线错了
vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => {
      throw new Error('调度器用例不该访问数据库')
    }
  }
}))

vi.mock('../src/main/db/repositories/reminder.repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/db/repositories/reminder.repo')>()
  return {
    ...actual,
    // computeNextFireAt 用真实实现：重排算错一天在这里就会红，而不是等真机跨月才发现
    reminderRepo: {
      listDue: listDueMock,
      markFired: markFiredMock,
      markMissed: markMissedMock,
      scheduleNext: scheduleNextMock
    }
  }
})

import { initReminderScheduler, stopReminderScheduler } from '../src/main/reminder/scheduler'

import { computeNextFireAt } from '../src/main/db/repositories/reminder.repo'
// 真状态机：闸门判的就是它，桩掉等于没测（用例里只调 lock/unlock，不起 init 的定时器）
import { lockService } from '../src/main/lock/lock'

beforeEach(() => {
  vi.useFakeTimers()
  lockService.unlock()
  scheduleNextMock.mockClear()
  notificationShowMock.mockClear()
  notificationCtorMock.mockClear()
  broadcastMock.mockClear()
  markFiredMock.mockClear()
  markMissedMock.mockClear()
  scheduleNextMock.mockClear()
  listDueMock.mockClear()
  logInfoMock.mockClear()
  logDebugMock.mockClear()
  listDueMock.mockImplementation(() => [])
})

afterEach(() => {
  stopReminderScheduler()
  lockService.unlock()
  vi.useRealTimers()
})

describe('reminder scheduler', () => {
  it('启动时无过期提醒：不广播、不标 missed', () => {
    initReminderScheduler()
    expect(broadcastMock).not.toHaveBeenCalled()
    expect(markMissedMock).not.toHaveBeenCalled()
  })

  it('启动恢复：过期 pending 全部标 missed + 汇总广播一条', () => {
    listDueMock.mockImplementation(() => [
      { id: 'r1', text: 'a', fireAt: 1 },
      { id: 'r2', text: 'b', fireAt: 2 }
    ])
    initReminderScheduler()
    expect(markMissedMock).toHaveBeenCalledTimes(2)
    expect(broadcastMock).toHaveBeenCalledTimes(1)
    expect(broadcastMock.mock.calls[0]![1]).toEqual({ missed: 2 })
    // 恢复阶段不弹系统通知
    expect(notificationShowMock).not.toHaveBeenCalled()
  })

  it('tick 到期：系统通知 + 广播单条 + 标 fired', () => {
    initReminderScheduler()
    listDueMock.mockImplementation(() => [{ id: 'r3', text: '喝水', fireAt: 123 }])
    vi.advanceTimersByTime(30_000)
    expect(notificationCtorMock).toHaveBeenCalledWith({ title: 'PocketAI 提醒', body: '喝水' })
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(broadcastMock).toHaveBeenCalledWith('reminder:fired', { id: 'r3', text: '喝水', fireAt: 123 })
    expect(markFiredMock).toHaveBeenCalledWith('r3')
  })

  it('tick 扫描抛错（锁屏 DB 关闭）：静默跳过，下个 tick 恢复', () => {
    initReminderScheduler()
    listDueMock.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow()
    expect(broadcastMock).not.toHaveBeenCalled()
    listDueMock.mockImplementation(() => [{ id: 'r4', text: 'x', fireAt: 9 }])
    vi.advanceTimersByTime(30_000)
    expect(markFiredMock).toHaveBeenCalledWith('r4')
  })

  it('单条触发失败不中断后续条目', () => {
    initReminderScheduler()
    listDueMock.mockImplementation(() => [
      { id: 'r5', text: 'a', fireAt: 1 },
      { id: 'r6', text: 'b', fireAt: 2 }
    ])
    markFiredMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    vi.advanceTimersByTime(30_000)
    expect(markFiredMock).toHaveBeenCalledTimes(2)
    expect(broadcastMock).toHaveBeenCalledTimes(2)
  })

  it('重复 init 不产生多个 timer；stop 后不再 tick', () => {
    initReminderScheduler()
    initReminderScheduler()
    stopReminderScheduler()
    listDueMock.mockImplementation(() => [{ id: 'r7', text: 'x', fireAt: 1 }])
    vi.advanceTimersByTime(60_000)
    expect(markFiredMock).not.toHaveBeenCalled()
  })
})

describe('循环提醒的重排接线（fireOne 的 repeatRule 分支）', () => {
  const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m, d, h, min, 0, 0).getTime()

  it('带循环规则到点：弹通知 + 广播，走 scheduleNext 重排，绝不标 fired', () => {
    vi.setSystemTime(at(2026, 9, 1, 10, 0))
    const rule = { kind: 'daily', intervalDays: 1 } as const
    initReminderScheduler()
    listDueMock.mockImplementation(() => [
      { id: 'c1', text: '喝水', fireAt: at(2026, 9, 1, 9, 0), repeatRule: rule }
    ])
    vi.advanceTimersByTime(30_000)
    expect(notificationShowMock).toHaveBeenCalledTimes(1)
    expect(broadcastMock).toHaveBeenCalledWith('reminder:fired', {
      id: 'c1',
      text: '喝水',
      fireAt: at(2026, 9, 1, 9, 0)
    })
    expect(markFiredMock).not.toHaveBeenCalled()
    // 下次时刻由真实 computeNextFireAt 算出：prev + 1 天
    expect(scheduleNextMock).toHaveBeenCalledWith('c1', at(2026, 9, 2, 9, 0), rule)
  })

  it('无循环规则到点：标 fired，不重排', () => {
    initReminderScheduler()
    listDueMock.mockImplementation(() => [{ id: 'o1', text: 'x', fireAt: 1 }])
    vi.advanceTimersByTime(30_000)
    expect(markFiredMock).toHaveBeenCalledWith('o1')
    expect(scheduleNextMock).not.toHaveBeenCalled()
  })

  it('每周多选：周三那次触发后，下一次排到最近命中的日子而不是第一个勾的', () => {
    vi.setSystemTime(at(2026, 9, 7, 12, 0)) // 周三中午
    const prev = at(2026, 9, 7, 9, 0)
    initReminderScheduler()
    listDueMock.mockImplementation(() => [
      { id: 'w1', text: '周会', fireAt: prev, repeatRule: { kind: 'weekly', weekdays: [3, 5] } }
    ])
    vi.advanceTimersByTime(30_000)
    const next = scheduleNextMock.mock.calls[0]![1] as number
    const d = new Date(next)
    expect(d.getDay()).toBe(5) // 周五，而不是周一
    expect(d.getHours()).toBe(9)
  })

  it('每月 31 号：2 月末触发后下一次要回到 3 月 31 号（曾被预夹成 28 而永久卡在月末）', () => {
    vi.setSystemTime(at(2026, 1, 28, 10, 0))
    const febLast = at(2026, 1, 28, 9, 0)
    const rule = { kind: 'monthly', dayOfMonth: 31 } as const
    initReminderScheduler()
    listDueMock.mockImplementation(() => [{ id: 'mo1', text: '对账', fireAt: febLast, repeatRule: rule }])
    vi.advanceTimersByTime(30_000)
    const next = scheduleNextMock.mock.calls[0]![1] as number
    const d = new Date(next)
    expect([d.getMonth(), d.getDate()]).toEqual([2, 31]) // 3 月有 31 号，不能被粘在 28
    // 直接从 1/31 起算时，2 月没有 31 号 → 落到 2 月最后一天
    expect(new Date(computeNextFireAt(at(2026, 0, 31, 9, 0), rule, at(2026, 1, 1, 8, 0))).getDate()).toBe(28)
  })

  it('重排抛错（DB 中途被锁）不中断后续条目，也不误标 fired', () => {
    initReminderScheduler()
    listDueMock.mockImplementation(() => [
      { id: 'e1', text: 'a', fireAt: 1, repeatRule: { kind: 'daily', intervalDays: 1 } },
      { id: 'e2', text: 'b', fireAt: 2 }
    ])
    scheduleNextMock.mockImplementationOnce(() => {
      throw new Error('db closed')
    })
    vi.advanceTimersByTime(30_000)
    expect(scheduleNextMock).toHaveBeenCalledTimes(1) // e1 失败后不再重试
    expect(markFiredMock).toHaveBeenCalledWith('e2') // 后面那条一次性照常处理
    expect(markFiredMock).not.toHaveBeenCalledWith('e1')
  })

  it('启动恢复阶段：过期的循环提醒也只标 missed，不自动重排（恢复策略由用户决定）', () => {
    listDueMock.mockImplementation(() => [
      { id: 'm1', text: 'a', fireAt: 1, repeatRule: { kind: 'daily', intervalDays: 1 } }
    ])
    initReminderScheduler()
    expect(markMissedMock).toHaveBeenCalledWith('m1')
    expect(scheduleNextMock).not.toHaveBeenCalled()
    expect(notificationShowMock).not.toHaveBeenCalled()
  })
})

describe('锁屏期间整轮暂缓（V4-Iter-198）', () => {
  it('锁定中到点：不弹通知、不广播、不标 fired、不重排，并记一条「暂缓 N 条」', () => {
    initReminderScheduler()
    lockService.lock('manual')
    listDueMock.mockImplementation(() => [
      { id: 'l1', text: '吃药', fireAt: 1 },
      { id: 'l2', text: '喝水', fireAt: 2, repeatRule: { kind: 'daily', intervalDays: 1 } }
    ])
    vi.advanceTimersByTime(30_000)
    expect(notificationCtorMock).not.toHaveBeenCalled()
    expect(broadcastMock).not.toHaveBeenCalled()
    expect(markFiredMock).not.toHaveBeenCalled()
    expect(scheduleNextMock).not.toHaveBeenCalled()
    expect(logInfoMock).toHaveBeenCalledWith('锁屏期间暂缓 2 条提醒（解锁后补发）')
  })

  it('解锁后的下一个 tick 补发同一条：通知与 fired 都照常（暂缓不是丢弃）', () => {
    initReminderScheduler()
    lockService.lock('manual')
    listDueMock.mockImplementation(() => [{ id: 'l3', text: '取快递', fireAt: 5 }])
    vi.advanceTimersByTime(30_000)
    expect(notificationShowMock).not.toHaveBeenCalled()
    lockService.unlock()
    vi.advanceTimersByTime(30_000)
    expect(notificationCtorMock).toHaveBeenCalledWith({ title: 'PocketAI 提醒', body: '取快递' })
    expect(markFiredMock).toHaveBeenCalledWith('l3')
  })

  it('反向对照：锁屏但没有到期项 ⇒ 不写那句「暂缓」（否则日志在承诺没发生的事）', () => {
    initReminderScheduler()
    lockService.lock('manual')
    listDueMock.mockImplementation(() => [])
    vi.advanceTimersByTime(30_000)
    const deferred = logInfoMock.mock.calls.flat().filter((a) => String(a).includes('暂缓'))
    expect(deferred).toEqual([])
  })

  it('启动恢复不受闸门影响：过期仍标 missed（这条路径本来就不弹通知，missed 由用户从历史 tab 决定）', () => {
    lockService.lock('manual')
    listDueMock.mockImplementation(() => [{ id: 'l4', text: 'x', fireAt: 1 }])
    initReminderScheduler()
    expect(markMissedMock).toHaveBeenCalledWith('l4')
    expect(broadcastMock).toHaveBeenCalledWith('reminder:fired', { missed: 1 })
    expect(notificationCtorMock).not.toHaveBeenCalled()
  })
})
