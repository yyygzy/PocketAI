// 回复完成系统通知
//
// - 开关存 appConfig KV（缺省开启），与 title-config 同构
// - 通知统一由主进程发出（Electron Notification，Windows toast 经 AppUserModel）
// - 点击通知聚焦并还原主窗口；任何失败静默，绝不阻断对话
import { BrowserWindow, Notification } from 'electron'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { MAIN_WINDOW_MARKER, type MarkedBrowserWindow } from '../ui-preferences'
import { createLogger } from '../logger'

const log = createLogger('reply-notify')

const K_REPLY_NOTIFY_ENABLED = 'notify.reply_done'

/** 是否启用「回复完成系统通知」；未配置时默认开启 */
export function isReplyNotifyEnabled(): boolean {
  return appConfigRepo.get(K_REPLY_NOTIFY_ENABLED) !== '0'
}

export function setReplyNotifyEnabled(enabled: boolean): boolean {
  appConfigRepo.set(K_REPLY_NOTIFY_ENABLED, enabled ? '1' : '0')
  return isReplyNotifyEnabled()
}

/** 找到带主窗口标记的 BrowserWindow（排除浮窗/独立窗） */
function findMainWindow(): BrowserWindow | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if ((win as MarkedBrowserWindow)[MAIN_WINDOW_MARKER] === true) return win
  }
  return null
}

/**
 * 弹出一条系统通知；不支持/异常时静默忽略。
 * 点击通知：还原最小化 → show → focus 主窗口。
 */
export function showReplyNotification(title: string, body: string): void {
  try {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body })
    n.on('click', () => {
      const win = findMainWindow()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch (e) {
    log.warn(`回复通知失败: ${String(e)}`)
  }
}
