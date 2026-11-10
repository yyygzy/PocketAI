// 主题 KV 回填（A-3 收尾）
//
// 主题的第一事实来源仍是 renderer 的 localStorage；ui.theme 只是主进程建窗用的镜像。
// 老版本升级/首装时 KV 还是空的，浅色用户会先看到一帧深色底——这里在启动时补一次：
// 只有「KV 无值」才把当前生效主题写进去，之后启动 BrowserWindow 就能直接用对底色。
// 写失败只记诊断日志，不影响渲染；KV 有值时一律以 KV 为准，不改现有语义。
import { hasIpcFailed, logIpcError, reportIpcError } from './utils/ipc'
import { themeIdFromClasses } from '../../shared/themes'

/** 启动期调用一次；KV 已有合法值时不写盘（避免每次启动都刷一次 KV） */
export async function backfillThemeIfUnset(): Promise<void> {
  try {
    const r = await window.pocketai.getUiTheme()
    if (hasIpcFailed(r)) {
      logIpcError('ui.getTheme', r.error)
      return
    }
    if (!r.data || r.data.theme) return
    // 当前生效主题从 <html> 的 class 反查（theme-init.js 已按注册表还原），不再假设"非浅即深"
    const current = themeIdFromClasses(document.documentElement.classList)
    const w = await window.pocketai.setUiTheme(current)
    if (hasIpcFailed(w)) logIpcError('ui.setTheme', w.error)
  } catch (e) {
    reportIpcError('ui.theme.backfill')(e)
  }
}
