// unlock-coordinator 解锁协调器测试
//
// 覆盖 boot 流程 ↔ IPC handler 之间的解锁协调状态机：
// - waitForUnlock 挂起等待、isWaiting 状态翻转
// - submit 三种结果（password / setPassword / null）正确回传
// - 重复 submit、未等待时 submit/cancel 的边界行为
//
// 策略：UnlockCoordinator 为纯 EventEmitter 状态机（无外部依赖），
// 通过导出的类创建全新实例做隔离测试，另验证单例导出可用。
import { describe, it, expect } from 'vitest'
import { UnlockCoordinator, unlockCoordinator } from '../src/main/crypto/unlock-coordinator'

describe('UnlockCoordinator — 等待与提交', () => {
  it('waitForUnlock 后进入等待态，promise 保持挂起', () => {
    const c = new UnlockCoordinator()
    const p = c.waitForUnlock()
    expect(c.isWaiting()).toBe(true)
    let settled = false
    void p.then(() => {
      settled = true
    })
    return Promise.resolve().then(() => {
      expect(settled).toBe(false)
    })
  })

  it('submit({ password }) → 等待方收到密码，等待态复位', async () => {
    const c = new UnlockCoordinator()
    const p = c.waitForUnlock()
    c.submit({ password: 'secret' })
    await expect(p).resolves.toEqual({ password: 'secret' })
    expect(c.isWaiting()).toBe(false)
  })

  it('submit({ setPassword }) → 明文库首次设密结果正确回传', async () => {
    const c = new UnlockCoordinator()
    const p = c.waitForUnlock()
    c.submit({ setPassword: 'new-pwd' })
    await expect(p).resolves.toEqual({ setPassword: 'new-pwd' })
  })

  it('submit(null) → 等待方收到 null（用户放弃）', async () => {
    const c = new UnlockCoordinator()
    const p = c.waitForUnlock()
    c.submit(null)
    await expect(p).resolves.toBeNull()
  })

  it('cancel() 等价于 submit(null)', async () => {
    const c = new UnlockCoordinator()
    const p = c.waitForUnlock()
    c.cancel()
    await expect(p).resolves.toBeNull()
    expect(c.isWaiting()).toBe(false)
  })
})

describe('UnlockCoordinator — 边界行为', () => {
  it('未等待时 submit → 无抛错、状态不变', () => {
    const c = new UnlockCoordinator()
    expect(() => c.submit({ password: 'x' })).not.toThrow()
    expect(c.isWaiting()).toBe(false)
  })

  it('未等待时 cancel → 无抛错', () => {
    const c = new UnlockCoordinator()
    expect(() => c.cancel()).not.toThrow()
  })

  it('resolve 后再次 submit → 被忽略（resolver 已清空）', async () => {
    const c = new UnlockCoordinator()
    const p1 = c.waitForUnlock()
    c.submit({ password: 'first' })
    await expect(p1).resolves.toEqual({ password: 'first' })
    // 此时无等待方，第二次提交应静默忽略而不是抛错
    expect(() => c.submit({ password: 'second' })).not.toThrow()
    expect(c.isWaiting()).toBe(false)
  })

  it('串行复用：第一次完成后可再次 waitForUnlock', async () => {
    const c = new UnlockCoordinator()
    const p1 = c.waitForUnlock()
    c.submit({ password: 'a' })
    await expect(p1).resolves.toEqual({ password: 'a' })
    const p2 = c.waitForUnlock()
    expect(c.isWaiting()).toBe(true)
    c.submit({ setPassword: 'b' })
    await expect(p2).resolves.toEqual({ setPassword: 'b' })
  })
})

describe('UnlockCoordinator — 单例导出', () => {
  it('unlockCoordinator 是 UnlockCoordinator 实例且具备协调能力', async () => {
    expect(unlockCoordinator).toBeInstanceOf(UnlockCoordinator)
    // 单例被其他模块共享，测试用完必须复位，避免污染同文件外的状态
    const p = unlockCoordinator.waitForUnlock()
    unlockCoordinator.cancel()
    await expect(p).resolves.toBeNull()
  })
})
