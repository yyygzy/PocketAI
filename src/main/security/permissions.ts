// Chromium 权限收口：默认拒绝一切权限请求/检查
//
// 修复背景：Electron 在未注册权限处理器时，默认行为是「全部批准」——
// 已由 v44 C++ 源码（electron_permission_manager.cc）证实：
//  - RequestPermission 无 handler 时对每个权限返回 PermissionStatus::GRANTED，
//    geolocation 还会主动 UserDidOptIntoLocationServices，MIDI_SYSEX 额外授予系统能力；
//  - CheckPermission 无 handler 时除 DEPRECATED_SYNC_CLIPBOARD_READ 外全部返回 true。
//
// 本应用不可信脚本能跑的地方：
//  - js_eval 工具的隐藏窗口（默认 session，data: 安全上下文，执行 LLM/Agent 给的 JS）；
//  - SandboxModule 的 srcdoc iframe（sandbox=allow-scripts，预览不可信 HTML）。
// 默认批准意味着这些脚本能直接调起摄像头/麦克风、读定位、发系统通知、读剪贴板。
//
// 渲染层自身不使用任何需要授权的 Web API（已全仓 grep 确认）：
// 无 getUserMedia / geolocation / Notification / requestFullscreen / pointerLock；
// 剪贴板只写不读，且 writeClipboard 在 Clipboard API 失败时有 execCommand 兜底。
// 故本批次零白名单、默认全拒。
import { session } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('permissions')

/**
 * 权限决策纯函数：默认拒绝一切。
 * 未来如确需开放某权限（如语音输入），必须在此处显式白名单，
 * 并结合 requestingUrl 校验请求只来自应用主 frame——禁止无差别返回 true。
 */
export function isPermissionAllowed(_permission: string, _requestingUrl?: string): boolean {
  return false
}

/** 在 app ready 后、任何窗口创建前安装；defaultSession 覆盖全部窗口（无自定义 partition） */
export function installPermissionGuards(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const requestingUrl = details.requestingUrl ?? ''
    if (isPermissionAllowed(permission, requestingUrl)) {
      callback(true)
      return
    }
    // 权限被授予是静默的（摄像头指示灯可能被忽略），拒绝事件必须留痕
    log.warn(`拒绝权限请求: ${permission}${requestingUrl ? ` 来源: ${requestingUrl}` : ''}`)
    callback(false)
  })

  // 非提示式检查：navigator.permissions.query / Notification.permission /
  // clipboard.readText 的预检等。check 可能被页面高频轮询，记 debug 即可。
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (isPermissionAllowed(permission)) return true
    log.debug(`拒绝权限检查: ${permission}`)
    return false
  })
}
