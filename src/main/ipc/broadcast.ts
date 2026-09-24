// IPC 广播工具：向所有存活的 BrowserWindow 推送事件
// 单窗口 send 异常（如销毁竞态）不应中断其它窗口的广播，也不向调用方冒泡
import { BrowserWindow } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('broadcast')

export function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, data)
      } catch (e) {
        // isDestroyed 检查后、send 前的销毁竞态：跳过该窗口继续广播
        log.warn(`广播 ${channel} 到某窗口失败:`, e)
      }
    }
  }
}
