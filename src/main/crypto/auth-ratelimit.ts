// AuthRateLimiter：认证失败限流器（主进程权威，防通过解锁窗在线暴力穷举）
//
// 威胁模型与边界：
// - 状态只存内存：重启应用会重置计数。对便携应用而言，拿到 DB 文件的离线穷举
//   无法靠软件退避阻止（可删状态文件、可离线算），真正防线是 scrypt KDF 的单次
//   派生成本。本模块解决的是「不重启应用、在解锁窗里无限试密码/恢复码」——
//   此前计数在渲染层，刷新/重开解锁窗即可绕过；现在计数在主进程，无法绕过。
// - 解锁窗挂载时通过 ENCRYPTION_AUTH_STATUS 拉取剩余锁定时间，重载窗口也保持锁定。

export const AUTH_BUCKET = {
  UNLOCK: 'unlock',
  RECOVER: 'recover'
} as const

export type AuthBucket = (typeof AUTH_BUCKET)[keyof typeof AUTH_BUCKET]

/** 连续失败次数达到该阈值起开始锁定 */
export const FAIL_THRESHOLD = 5
/** 首次锁定时长 1s，之后每次失败翻倍 */
const BASE_BACKOFF_MS = 1000
/** 退避上限 30s（与解锁窗倒计时展示对齐） */
export const MAX_BACKOFF_MS = 30_000

export interface AuthVerdict {
  allowed: boolean
  /** 距放行剩余毫秒（allowed=true 时为 0） */
  retryAfterMs: number
  /** 当前桶累计连续失败次数（供 UI 提示） */
  attempts: number
}

interface BucketState {
  count: number
  lockedUntil: number
}

export class AuthRateLimiter {
  private buckets = new Map<string, BucketState>()

  /** 锁定中返回剩余时间；锁定期满则放行但保留计数（下一次失败继续翻倍） */
  check(key: string, now: number = Date.now()): AuthVerdict {
    const b = this.buckets.get(key)
    if (!b) return { allowed: true, retryAfterMs: 0, attempts: 0 }
    const retryAfterMs = b.lockedUntil - now
    if (retryAfterMs > 0) {
      return { allowed: false, retryAfterMs, attempts: b.count }
    }
    return { allowed: true, retryAfterMs: 0, attempts: b.count }
  }

  /** 记录一次失败：未到阈值只计数；到阈值起锁/延长锁，返回最新裁决 */
  fail(key: string, now: number = Date.now()): AuthVerdict {
    const b: BucketState = this.buckets.get(key) ?? { count: 0, lockedUntil: 0 }
    b.count += 1
    if (b.count >= FAIL_THRESHOLD) {
      const backoff = Math.min(
        BASE_BACKOFF_MS * 2 ** (b.count - FAIL_THRESHOLD),
        MAX_BACKOFF_MS
      )
      b.lockedUntil = now + backoff
    }
    this.buckets.set(key, b)
    return this.check(key, now)
  }

  /** 认证成功：清零该桶（恢复码重置成功时连 unlock 桶一起清，因密码已变更） */
  reset(key: string): void {
    this.buckets.delete(key)
  }
}

export const authRateLimiter = new AuthRateLimiter()
