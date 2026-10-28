// §346：许可证状态在渲染层也是一份副本，而它有两个读者——这份文件是唯一写这份副本的地方。
//
// 两个读者（都在 modules/settings/SettingsModule.tsx）：
//  - 挂载那一发：本页出生时读一次（与路径／更新信息同一个 effect）；
//  - 面板动作那一发：`LicensePanel` 的四个动作成功后都调 `onChange` 重取——
//    「激活」（选文件，:1710）、「清除」(:1724)、「粘贴激活码」(:1735)、「卡密在线激活」(:1754)，
//    外加 §345 挂在旧值横幅上那颗「重试」(:1771)。
//
// 为什么这一族的并发是**用户做得出的动作**（不像看起来那样被 `busy` 挡住）：
// 三颗激活键的 `disabled={busy}` 管的是"动作本身在飞"，而 `onChange()` 是在 try 里**不等**地调用、
// `finally` 立刻把 busy 放开（:1705→:1713、:1729→:1738、:1743→:1758）⇒ 存在一段"读数还在飞、键已能再点"的窗口；
// 而这段时间里屏上的 `lic` 还是**动作前那份**（未授权那张脸，激活 UI 在场），
// 所以"换一份许可证再激活一次"是可达路径。此时磁盘上已是第二份，先那一发若迟到就把面板画回**已被覆盖的那份**
// ——plan／持有人／到期日都是旧的，而这一屏下面正是「清除」与到期日两处给人做决定的地方。
// 口径同 §344（加密态三读者并一份）与 §324／§311／§309（迟到响应缺归属判据）：**只有最新那一发能写回**。
//
// 失败侧只报「刷新失败」的原因、**不动旧值**：读不到不等于"没授权"，把副本清成 null 会让这一屏
// 从「已授权 pro」翻成「未授权／免费版」，那是比旧值更大的一次谎（§342 同一条取向）。
import { hasIpcFailed, ipcFailText, logIpcError } from './ipc'
import { errText } from './error'
import type { LicenseStatus } from '../../../shared/types'

export interface LicenseStatusSyncDeps {
  setStatus: (v: LicenseStatus) => void
  setErr: (v: string | null) => void
  t: (k: string) => string
}

/** 读一次主进程的许可证状态并写回本页那份副本；代次守卫＝晚到的旧响应一个字都不许上屏。 */
export function createLicenseStatusSyncer(deps: LicenseStatusSyncDeps): () => Promise<void> {
  let gen = 0
  return async () => {
    const my = ++gen
    try {
      const s = await window.pocketai.getLicenseStatus()
      if (my !== gen) return
      if (hasIpcFailed(s)) {
        deps.setErr(ipcFailText(s, deps.t('common.unknownError')))
        return
      }
      deps.setErr(null)
      deps.setStatus(s)
    } catch (e) {
      if (my !== gen) return
      deps.setErr(errText(e, deps.t('common.unknownError')))
      logIpcError('license-copy.getLicenseStatus', e)
    }
  }
}
