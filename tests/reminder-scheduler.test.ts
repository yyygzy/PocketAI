// reminder scheduler 单元测试：到期触发 / 重启 missed 恢复 / 锁屏 DB 关闭容错
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { notificationShowMock, notificationCtorMock, broadcastMock, listDueMock, markFiredMock, markMissedMock } =
  vi.hoisted(() => ({
    notificationShowMock: vi.fn(),
    notificationCtorMock: vi.fn(),
    broadcastMock: vi.fn(),
    listDueMock: vi.fn<() => unknown[]>(() => []),
    markFiredMock: vi.fn(),
    markMissedMock: vi.fn()
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
vi.mock('../src/main/db/repositories/reminder.repo', () => ({
  reminderRepo: {
    listDue: listDueMock,
    markFired: markFiredMock,
    markMissed: markMissedMock
  }
}))

import { initReminderScheduler, stopReminderScheduler } from '../src/main/reminder/scheduler'

beforeEach(() => {
  vi.useFakeTimers()
  notificationShowMock.mockClear()
  notificationCtorMock.mockClear()
  broadcastMock.mockClear()
  markFiredMock.mockClear()
  markMissedMock.mockClear()
  listDueMock.mockClear()
  listDueMock.mockImplementation(() => [])
})

afterEach(() => {
  stopReminderScheduler()
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
