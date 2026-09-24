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

export function registerLockHandlers(): void {
  safeHandle(IPC.LOCK_GET_STATUS, () => lockService.getStatus())
  safeHandle(IPC.LOCK_LOCK, () => {
    lockService.lock('manual')
    return { ok: true }
  })
  safeHandle(IPC.LOCK_UNLOCK, (_e, password?: string) => {
    // db 模式锁定时密钥已被清除、库已被关闭（见 index.ts 锁订阅），
    // 内存比对不可用，只能用「重新派生 + 重开探针」验证密码
    if (masterKeyManager.getMode() === 'db') {
      if (!password) return { ok: false, error: '密码错误' }
      const salt = appConfigRepo.getMasterPasswordSalt()
      try {
        const key = masterKeyManager.setKey(password, salt ?? undefined)
        dbService.open(key)
        dbService.getHandle().prepare('SELECT 1').get()
      } catch {
        masterKeyManager.clear()
        dbService.close()
        return { ok: false, error: '密码错误' }
      }
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
