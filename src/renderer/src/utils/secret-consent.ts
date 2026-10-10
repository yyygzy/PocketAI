// B3 口径（SEC-1）：渠道 token / 联网搜索 Key 这类「无人值守依赖」的凭据不拦写入，
// 但保存**新值**前必须让用户显式承认「未设主密码时这只是本地混淆」。
// 判定只问主进程要一次实时状态——面板长期挂载，缓存模式会在用户设完密码后失效。
import { logIpcError } from './ipc'

/** 当前是否为「未设主密码」模式；读不到状态时按「不必打扰」处理 */
export async function isUnprotectedMode(): Promise<boolean> {
  try {
    return (await window.pocketai.getEncryptionStatus()).mode === 'none'
  } catch (e) {
    logIpcError('secretConsent.getEncryptionStatus', e)
    return false
  }
}
