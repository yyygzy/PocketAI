// IPC 广播工具：向所有存活的 BrowserWindow 推送事件
import { BrowserWindow } from 'electron'

export function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}
