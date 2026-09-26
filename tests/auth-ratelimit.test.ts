// auth-ratelimit 主进程认证限流测试
//
// 覆盖 src/main/crypto/auth-ratelimit.ts：
// 阈值内只计数不锁定、第 5 次起锁、指数退避翻倍、30s 上限、
// 锁定期满放行但保留计数（再失败继续翻倍）、reset 清零、两桶相互独立。
import { describe, it, expect, beforeEach } from 'vitest'
import { AuthRateLimiter, AUTH_BUCKET, FAIL_THRESHOLD, MAX_BACKOFF_MS } from '../src/main/crypto/auth-ratelimit'

describe('AuthRateLimiter', () => {
  let rl: AuthRateLimiter
  const T0 = 1_000_000

  beforeEach(() => {
    rl = new AuthRateLimiter()
  })

  it('阈值内失败只计数，不锁定', () => {
    for (let i = 1; i < FAIL_THRESHOLD; i++) {
      const v = rl.fail(AUTH_BUCKET.UNLOCK, T0)
      expect(v.allowed).toBe(true)
      expect(v.retryAfterMs).toBe(0)
      expect(v.attempts).toBe(i)
    }
    // check 始终放行
    expect(rl.check(AUTH_BUCKET.UNLOCK, T0).allowed).toBe(true)
  })

  it('第 5 次失败起锁，首次退避 1s', () => {
    for (let i = 1; i < 5; i++) rl.fail(AUTH_BUCKET.UNLOCK, T0)
    const v = rl.fail(AUTH_BUCKET.UNLOCK, T0)
    expect(v.allowed).toBe(false)
    expect(v.attempts).toBe(5)
    expect(v.retryAfterMs).toBe(1000)
  })

  it('退避按指数翻倍，上限 30s', () => {
    const expected = [1000, 2000, 4000, 8000, 16000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]
    // 前 4 次不锁定
    for (let i = 0; i < 4; i++) rl.fail(AUTH_BUCKET.UNLOCK, T0)
    for (const ms of expected) {
      // 每次失败发生在上一轮锁定期满之后
      const v = rl.fail(AUTH_BUCKET.UNLOCK, T0 + ms + 1)
      expect(v.allowed).toBe(false)
      expect(v.retryAfterMs).toBe(ms)
    }
  })

  it('锁定期内 check 拒绝；期满放行且保留计数，再失败继续翻倍', () => {
    for (let i = 0; i < 5; i++) rl.fail(AUTH_BUCKET.UNLOCK, T0) // 锁到 T0+1000
    expect(rl.check(AUTH_BUCKET.UNLOCK, T0 + 500).allowed).toBe(false)
    expect(rl.check(AUTH_BUCKET.UNLOCK, T0 + 500).retryAfterMs).toBe(500)

    // 期满：放行，计数仍为 5
    const expired = rl.check(AUTH_BUCKET.UNLOCK, T0 + 1001)
    expect(expired.allowed).toBe(true)
    expect(expired.attempts).toBe(5)

    // 再失败：第 6 次 → 2s
    const v = rl.fail(AUTH_BUCKET.UNLOCK, T0 + 1001)
    expect(v.attempts).toBe(6)
    expect(v.retryAfterMs).toBe(2000)
  })

  it('reset 清零计数与锁定', () => {
    for (let i = 0; i < 5; i++) rl.fail(AUTH_BUCKET.UNLOCK, T0)
    expect(rl.check(AUTH_BUCKET.UNLOCK, T0).allowed).toBe(false)
    rl.reset(AUTH_BUCKET.UNLOCK)
    const v = rl.check(AUTH_BUCKET.UNLOCK, T0)
    expect(v).toEqual({ allowed: true, retryAfterMs: 0, attempts: 0 })
  })

  it('unlock 与 recover 两桶计数互不影响', () => {
    for (let i = 0; i < 5; i++) rl.fail(AUTH_BUCKET.UNLOCK, T0)
    expect(rl.check(AUTH_BUCKET.UNLOCK, T0).allowed).toBe(false)
    // recover 桶仍完全空闲
    expect(rl.check(AUTH_BUCKET.RECOVER, T0)).toEqual({ allowed: true, retryAfterMs: 0, attempts: 0 })

    const r = rl.fail(AUTH_BUCKET.RECOVER, T0)
    expect(r.attempts).toBe(1)
    expect(r.allowed).toBe(true)
  })

  it('从未失败的桶 check 默认放行', () => {
    expect(rl.check('any', T0)).toEqual({ allowed: true, retryAfterMs: 0, attempts: 0 })
  })
})
