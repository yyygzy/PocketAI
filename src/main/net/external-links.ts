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

import { shell } from 'electron'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('external-links')

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
    const current = originOf(webContents.getURL())
    const target = originOf(targetUrl)
    // 同源放行（生产 file:// 页面之间、开发 vite dev server 内部）
    if (current && target && current === target) return
    e.preventDefault()
    openExternalSecure(targetUrl)
  })
}
