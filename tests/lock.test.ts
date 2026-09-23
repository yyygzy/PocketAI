// 隐私锁状态机测试（LockService）
//
// 策略：LockService 是纯 EventEmitter 状态机（unlocked ↔ locked），定时器来源：
//   - init() 启动 checkAutoLock 轮询（10s 间隔），到 autoLockTimeout 锁 'auto-timeout'
//   - onAppHidden() 启动 idleTimer，到 autoLockTimeout 锁 'app-hidden'
//   - markIdle() 启动 idleTimer，到 autoLockTimeout 锁 'auto-timeout'
//   - onOsSleep() 同步立即锁 'os-sleep'
// 用 vi.useFakeTimers 固定起点，每用例 new LockService() 隔离状态；onStateChange
// 捕获事件数组断言 reason 与触发顺序。顺带验证 markIdle 重复调用清旧 timer 的修复。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LockService } from '../src/main/lock/lock'
import type { LockStateEvent } from '../src/shared/types'

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()

let svc: LockService

beforeEach(() => {
  vi.useFakeTimers({ now: BASE_TIME })
  svc = new LockService()
})

afterEach(() => {
  svc.destroy()
  vi.useRealTimers()
})

describe('LockService — 初始状态与基础转换', () => {
  it('初始 unlocked，lastUnlockedAt 取构造时间，autoLockTimeout=0', () => {
    const s = svc.getStatus()
    expect(s.state).toBe('unlocked')
    expect(s.lastUnlockedAt).toBe(BASE_TIME)
    expect(s.autoLockTimeout).toBe(0)
  })

  it('lock() unlocked → locked，emit state-change reason=manual', () => {
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.lock()
    expect(svc.getStatus().state).toBe('locked')
    expect(events).toEqual([{ state: 'locked', reason: 'manual' }])
  })

  it('lock() 已 locked 时为 no-op（不重复 emit，reason 不被覆盖）', () => {
    svc.lock('manual')
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.lock('os-sleep')
    expect(events).toEqual([])
    expect(svc.getStatus().state).toBe('locked')
  })

  it('unlock() locked → unlocked，刷新 lastUnlockedAt，emit reason=manual', () => {
    svc.lock()
    vi.advanceTimersByTime(5_000)
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.unlock()
    const s = svc.getStatus()
    expect(s.state).toBe('unlocked')
    expect(s.lastUnlockedAt).toBe(BASE_TIME + 5_000)
    expect(events).toEqual([{ state: 'unlocked', reason: 'manual' }])
  })

  it('unlock() 已 unlocked 时为 no-op', () => {
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.unlock()
    expect(events).toEqual([])
  })
})

describe('LockService — setAutoTimeout', () => {
  it('setAutoTimeout 正常设值；负数收敛为 0', () => {
    svc.setAutoTimeout(60_000)
    expect(svc.getStatus().autoLockTimeout).toBe(60_000)
    svc.setAutoTimeout(-100)
    expect(svc.getStatus().autoLockTimeout).toBe(0)
  })
})

describe('LockService — app-hidden / os-sleep 触发', () => {
  it('onAppHidden() 到 autoLockTimeout 触发 lock(app-hidden)；边界未到不锁', () => {
    svc.setAutoTimeout(30_000)
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.onAppHidden()
    expect(svc.getStatus().state).toBe('unlocked')
    vi.advanceTimersByTime(29_999) // 未到点
    expect(svc.getStatus().state).toBe('unlocked')
    vi.advanceTimersByTime(1) // 到 30000
    expect(events).toEqual([{ state: 'locked', reason: 'app-hidden' }])
  })

  it('onAppHidden() autoLockTimeout=0 → 不启动 timer', () => {
    svc.onAppHidden()
    vi.advanceTimersByTime(60_000)
    expect(svc.getStatus().state).toBe('unlocked')
  })

  it('onAppShown() 取消 app-hidden 延迟锁', () => {
    svc.setAutoTimeout(30_000)
    svc.onAppHidden()
    vi.advanceTimersByTime(20_000)
    svc.onAppShown()
    vi.advanceTimersByTime(30_000) // 越过原定 30s
    expect(svc.getStatus().state).toBe('unlocked')
  })

  it('onOsSleep() 立即 lock(os-sleep)', () => {
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.onOsSleep()
    expect(events).toEqual([{ state: 'locked', reason: 'os-sleep' }])
  })
})

describe('LockService — markIdle / markActive', () => {
  it('markIdle() 到 autoLockTimeout 触发 lock(auto-timeout)', () => {
    svc.setAutoTimeout(15_000)
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    svc.markIdle()
    vi.advanceTimersByTime(15_000)
    expect(events).toEqual([{ state: 'locked', reason: 'auto-timeout' }])
  })

  it('markIdle() autoLockTimeout=0 → 不锁', () => {
    svc.markIdle()
    vi.advanceTimersByTime(60_000)
    expect(svc.getStatus().state).toBe('unlocked')
  })

  it('markIdle() 重复调用不残留前一个 timer（重排场景避免提前锁）', () => {
    svc.setAutoTimeout(30_000)
    svc.markIdle() // 起点 t=0，timer 排到 t=30000
    vi.advanceTimersByTime(10_000) // t=10000
    // 用户短暂活跃后又闲置：markActive 清 timer + 刷新，markIdle 重排 30s
    svc.markActive()
    svc.markIdle() // 新 timer 应排到 t=40000
    vi.advanceTimersByTime(25_000) // t=35000，距新 markIdle 仅 25s < 30s
    expect(svc.getStatus().state).toBe('unlocked') // 旧 timer 已清，不应在 30000 处提前锁
    vi.advanceTimersByTime(5_000) // t=40000，到新 timer
    expect(svc.getStatus().state).toBe('locked')
  })

  it('markActive() 取消 idle 延迟锁并刷新 lastUnlockedAt', () => {
    svc.setAutoTimeout(15_000)
    svc.markIdle()
    vi.advanceTimersByTime(5_000)
    svc.markActive()
    expect(svc.getStatus().lastUnlockedAt).toBe(BASE_TIME + 5_000)
    vi.advanceTimersByTime(20_000) // 越过原定 15s
    expect(svc.getStatus().state).toBe('unlocked')
  })
})

describe('LockService — checkAutoLock 轮询（init）', () => {
  it('init() 轮询到 autoLockTimeout 触发 lock(auto-timeout)', () => {
    svc.setAutoTimeout(25_000)
    svc.init()
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    // 轮询间隔 10s：t=10（elapsed=10<25 不锁）、t=20（elapsed=20<25 不锁）、t=30（elapsed=30>=25 锁）
    vi.advanceTimersByTime(30_000)
    expect(events).toEqual([{ state: 'locked', reason: 'auto-timeout' }])
  })

  it('init() autoLockTimeout=0 → 轮询不锁', () => {
    svc.init()
    vi.advanceTimersByTime(120_000)
    expect(svc.getStatus().state).toBe('unlocked')
  })

  it('init() 已 locked → 轮询不重复 emit', () => {
    svc.lock()
    svc.setAutoTimeout(1_000)
    svc.init()
    const events: LockStateEvent[] = []
    svc.onStateChange((e) => events.push(e))
    vi.advanceTimersByTime(30_000)
    expect(events).toEqual([])
  })
})

describe('LockService — destroy 与订阅取消', () => {
  it('destroy() 清 checkTimer + idleTimer 且移除所有监听', () => {
    svc.setAutoTimeout(15_000)
    svc.init()
    svc.markIdle()
    const fn = vi.fn()
    svc.onStateChange(fn)
    svc.destroy()
    vi.advanceTimersByTime(60_000) // 越过所有到点
    expect(fn).not.toHaveBeenCalled()
  })

  it('onStateChange 返回取消订阅函数', () => {
    const fn = vi.fn()
    const off = svc.onStateChange(fn)
    svc.lock()
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    svc.unlock()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
