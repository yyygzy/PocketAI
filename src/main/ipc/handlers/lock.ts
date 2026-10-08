// 隐私锁 IPC：状态 / 锁定 / 解锁（db 模式下走重开探针验密）/ 自动超时 / 活跃标记
import { IPC } from '../../../shared/types'
import { lockService } from '../../lock/lock'
import { masterKeyManager } from '../../crypto/master-key'
import { clipboardGuard } from '../../crypto/clipboard-guard'
import { dbService } from '../../db/database'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { broadcast } from '../broadcast'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { masterPasswordSchema } from '../../../shared/schemas/encryption'
import { authRateLimiter, AUTH_BUCKET } from '../../crypto/auth-ratelimit'

export function registerLockHandlers(): void {
  safeHandle(IPC.LOCK_GET_STATUS, () => lockService.getStatus())
  safeHandle(IPC.LOCK_LOCK, () => {
    lockService.lock('manual')
    return { ok: true }
  })
  safeHandle(IPC.LOCK_UNLOCK, (_e, password?: string) => {
    // db 模式锁定时密钥已被清除、库已被关闭（见 index.ts 锁订阅），
    // 内存比对不可用，只能用「重新派生 + 重开探针」验证密码。
    // 该探针就是主密码校验点，必须与 ENCRYPTION_UNLOCK 共用限流桶（SEC-10）：
    // 本通道在锁网关白名单内，没有限流就等于在锁屏界面上提供无限次离线试密码。
    if (masterKeyManager.getMode() === 'db') {
      const bucket = AUTH_BUCKET.UNLOCK
      const gate = authRateLimiter.check(bucket)
      if (!gate.allowed) {
        return {
          ok: false as const,
          error: '尝试过于频繁，请稍后再试',
          locked: true,
          retryAfterMs: gate.retryAfterMs,
          attempts: gate.attempts
        }
      }
      if (!password) {
        const v = authRateLimiter.fail(bucket)
        return {
          ok: false as const,
          error: '密码错误',
          locked: v.retryAfterMs > 0,
          retryAfterMs: v.retryAfterMs,
          attempts: v.attempts
        }
      }
      const salt = appConfigRepo.getMasterPasswordSalt()
      try {
        const key = masterKeyManager.setKey(password, salt ?? undefined)
        dbService.open(key)
        dbService.getHandle().prepare('SELECT 1').get()
      } catch {
        masterKeyManager.clear()
        dbService.close()
        const v = authRateLimiter.fail(bucket)
        return {
          ok: false as const,
          error: '密码错误',
          locked: v.retryAfterMs > 0,
          retryAfterMs: v.retryAfterMs,
          attempts: v.attempts
        }
      }
      authRateLimiter.reset(bucket)
    }
    lockService.unlock()
    return { ok: true }
  }, argsSchema(masterPasswordSchema.optional()))
  safeHandle(IPC.LOCK_SET_AUTO_TIMEOUT, (_e, timeoutMs: number) => {
    lockService.setAutoTimeout(timeoutMs)
    return { ok: true }
  }, argsSchema(z.number().int().nonnegative()))
  safeHandle(IPC.LOCK_MARK_ACTIVE, () => {
    lockService.markActive()
    return { ok: true }
  })
  // 锁屏状态变化 → 广播；锁屏/应用隐藏时立即清除剪贴板中的敏感内容
  lockService.onStateChange((evt) => {
    if (evt.state === 'locked') clipboardGuard.purge()
    broadcast(IPC.LOCK_STATE_EVENT, evt)
  })
}
