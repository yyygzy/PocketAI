// B3 口径（SEC-1）：渠道 token / 联网搜索 Key 这类「无人值守依赖」的凭据不拦写入，
// 但保存**新值**前必须让用户显式承认「未设主密码时这只是本地混淆」。
// 判定只问主进程要一次实时状态——面板长期挂载，缓存模式会在用户设完密码后失效。
import { logIpcError, hasIpcFailed } from './ipc'

/** 当前是否为「未设主密码」模式；读不到状态时按「不必打扰」处理 */
export async function isUnprotectedMode(): Promise<boolean> {
  try {
    const s = await window.pocketai.getEncryptionStatus()
    // §223：`(await …).mode` 在失败对象上是 undefined ⇒ 结论恰好也是"不是 none"（与上面声明的
    // "读不到按不必打扰"同结果），但那条 catch 根本进不来，于是**一次痕都没留**。
    // 现在两面同口径：resolve 的失败也留痕（这个判定决定要不要弹凭据确认，静默错过不可审计）
    if (hasIpcFailed(s)) {
      logIpcError('secretConsent.getEncryptionStatus', s)
      return false
    }
    return s.mode === 'none'
  } catch (e) {
    logIpcError('secretConsent.getEncryptionStatus', e)
    return false
  }
}
