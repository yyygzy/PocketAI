// 外链收口：渲染进程内的 window.open / target=_blank 一律拒绝在应用内开窗，
// 仅允许 http/https 链接交给系统浏览器。
//
// 不做协议白名单的风险：setWindowOpenHandler 拿到的 url 可由页面内容控制，
// file:// 可读本地文件、javascript: 可在应用上下文执行、自定义协议可唤起
// 本机注册的危险 handler，必须默认拒绝。
//
// 同时拦截当前窗口的顶层导航（will-navigate）：preload 随 webContents 注入、
// 跨导航仍然生效，页面一旦被导航到攻击者控制的远程页，contextBridge 暴露的
// 整套 IPC API 就会落在远程页面的执行上下文里（等同把本机能力交出去）。
// 本应用渲染层只有 hash 路由（same-document 导航不触发 will-navigate），
// 故同源放行、跨源一律阻止并转系统浏览器，零功能影响。
//
// opaque origin 特例：file:// / data: / about:blank 的 origin 都是字符串
// 'null'，两两相等是假象，不能按同源放行——否则生产环境（渲染层以 file://
// 加载）任意 file://→file:// 导航（如把恶意 HTML 文件拖进窗口）都会被放行，
// 导航后 preload 重新注入、恶意页面获得完整 IPC 面。故 opaque origin 只
// 允许同文件导航（忽略 hash/search），跨文件一律阻止且不转系统浏览器。

import { shell } from 'electron'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('external-links')

/** opaque origin（file:/data:/about:blank 等）序列化后的字符串，不可用于同源比较 */
const OPAQUE_ORIGIN = 'null'

/** 仅放行 http/https，其余协议静默忽略 */
export function openExternalSecure(rawUrl: string): void {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    void shell.openExternal(u.toString()).catch((e) => log.error('openExternal 失败:', errMsg(e)))
  } catch {
    // 非法/相对 URL：忽略
  }
}

/** 取 URL 的 origin；非法 URL 返回 null */
export function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/** BrowserWindow 标准挂载：应用内拒开新窗 + 禁止顶层跨源导航，合法外链跳系统浏览器 */
export function denyNewWindows(webContents: Electron.WebContents): void {
  webContents.setWindowOpenHandler(({ url }) => {
    openExternalSecure(url)
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (e, targetUrl) => {
    const currentUrl = webContents.getURL()
    const current = originOf(currentUrl)
    const target = originOf(targetUrl)

    // 同源放行（dev vite origin 内部；生产 file:// 走下面的 opaque 分支）
    if (current && target && current !== OPAQUE_ORIGIN && current === target) {
      return
    }

    // opaque origin（file:// / data: / about:blank 等）：origin 全是 'null'，
    // 不能用 origin 比较；只允许同文件（去掉 hash/search 后路径相同），
    // 跨文件一律阻止且不转系统浏览器（file:// 不应跳到外部浏览器）。
    if (current === OPAQUE_ORIGIN && target === OPAQUE_ORIGIN) {
      try {
        const cur = new URL(currentUrl)
        const tgt = new URL(targetUrl)
        if (cur.pathname === tgt.pathname && cur.host === tgt.host) return
      } catch {
        // 任一 URL 非法则直接阻止
      }
      e.preventDefault()
      log.warn(`阻止 opaque-origin 跨文件导航: ${currentUrl} → ${targetUrl}`)
      return
    }

    e.preventDefault()
    openExternalSecure(targetUrl)
  })
}
