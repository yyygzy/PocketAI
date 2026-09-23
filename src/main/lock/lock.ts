// 隐私锁核心（M4.3）
// 锁屏状态机：unlocked ↔ locked
// 触发源：手动锁定 / 自动超时 / 应用隐藏 / 系统睡眠
//
// 隐私锁和加密层是两个独立机制：
// - 加密层保护磁盘上的数据（无密码则不加密）
// - 隐私锁保护运行时的 UI 可见性（锁屏遮罩 + 清除敏感上下文）
//
// 锁屏时：
//   1. 主进程广播 LOCK_STATE_EVENT(state=locked)
//   2. 各渲染进程收到后显示锁屏遮罩
//   3. 主进程清除内存中的密钥（如果启用了加密）
//   4. 解锁需要用户重新输入主密码

import { EventEmitter } from 'node:events'
import type { LockState, LockStateEvent, LockStatus } from '../../shared/types'

export type LockReason = 'manual' | 'auto-timeout' | 'app-hidden' | 'os-sleep'

const AUTO_LOCK_CHECK_INTERVAL = 10_000 // 10 秒检查一次

export class LockService extends EventEmitter {
  private state: LockState = 'unlocked'
  private lastUnlockedAt = Date.now()
  private autoLockTimeout = 0 // 0=永不自动锁
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private checkTimer: ReturnType<typeof setInterval> | null = null

  /** 初始化：启动自动检查 */
  init(): void {
    this.checkTimer = setInterval(() => this.checkAutoLock(), AUTO_LOCK_CHECK_INTERVAL)
  }

  /** 销毁：清除所有定时器 */
  destroy(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.removeAllListeners()
  }

  /** 获取当前状态快照 */
  getStatus(): LockStatus {
    return {
      state: this.state,
      lastUnlockedAt: this.lastUnlockedAt,
      autoLockTimeout: this.autoLockTimeout
    }
  }

  /** 手动锁定 */
  lock(reason: LockReason = 'manual'): void {
    if (this.state === 'locked') return
    this.state = 'locked'
    this.emit('state-change', {
      state: 'locked',
      reason
    } satisfies LockStateEvent)
  }

  /** 解锁（需要主密码验证在加密层完成后调用） */
  unlock(): void {
    if (this.state === 'unlocked') return
    this.state = 'unlocked'
    this.lastUnlockedAt = Date.now()
    this.emit('state-change', {
      state: 'unlocked',
      reason: 'manual'
    } satisfies LockStateEvent)
  }

  /** 设置自动锁屏超时（ms），0=永不自动锁 */
  setAutoTimeout(timeoutMs: number): void {
    this.autoLockTimeout = Math.max(0, timeoutMs)
  }

  /** 应用隐藏时调用（BrowserWindow 'hide' / 'minimize'） */
  onAppHidden(): void {
    if (this.state === 'unlocked') {
      if (this.autoLockTimeout > 0) {
        this.idleTimer = setTimeout(() => {
          this.lock('app-hidden')
        }, this.autoLockTimeout)
      }
    }
  }

  /** 应用重新显示时调用 */
  onAppShown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** 系统睡眠回调 */
  onOsSleep(): void {
    this.lock('os-sleep')
  }

  /** 系统唤醒回调 */
  onOsWake(): void {
    // 唤醒后保持锁定状态，等用户解锁
  }

  /** 手动空闲标记（可选：主进程在长时间无交互时调用） */
  markIdle(): void {
    if (this.autoLockTimeout > 0 && this.state === 'unlocked') {
      // 重复调用时先清前一个 idleTimer，避免旧 timer 拐留导致提前锁屏
      // （markActive/onAppShown 已在「活跃」时清；这里覆盖重排场景）
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.lock('auto-timeout'), this.autoLockTimeout)
    }
  }

  /** 手动活跃标记 */
  markActive(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.lastUnlockedAt = Date.now()
  }

  /** 定期检查是否超时 */
  private checkAutoLock(): void {
    if (this.autoLockTimeout <= 0 || this.state === 'locked') return
    const elapsed = Date.now() - this.lastUnlockedAt
    if (elapsed >= this.autoLockTimeout) {
      this.lock('auto-timeout')
    }
  }

  /** 订阅状态变化 */
  onStateChange(handler: (evt: LockStateEvent) => void): () => void {
    this.on('state-change', handler)
    return () => this.off('state-change', handler)
  }
}

export const lockService = new LockService()
