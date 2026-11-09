// 解锁窗口的唯一实现：启动期（boot 等主密码）与锁屏后重弹共用这一份。
//
// 此前 IPC 的 ENCRYPTION_LOCK 自己 new 了一个同样的窗口，既没置顶、也没有加载重试与
// 显示兜底，同一个窗口两套行为——白屏/被遮挡只在锁屏那条路复现。

import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { createLogger } from '../logger'
import { unlockCoordinator } from '../crypto/unlock-coordinator'
import { denyNewWindows } from '../net/external-links'
import { windowBackground } from '../ui-preferences'
import { appIconPath, installLoadRetry, installShowFallback } from './boot-guards'

const log = createLogger('boot')

export type UnlockWindowMode = 'unlock' | 'setPassword'

export interface ShowUnlockWindowOptions {
  /** 关窗＝用户放弃解锁（启动期强制模态）→ 取消 boot 的等待并退出应用 */
  quitOnClose?: boolean
}

let unlockWindow: BrowserWindow | null = null

/** 显示解锁窗（幂等：已存在时只重新置顶并抢焦点） */
export function showUnlockWindow(
  mode: UnlockWindowMode = 'unlock',
  options: ShowUnlockWindowOptions = {}
): void {
  if (unlockWindow && !unlockWindow.isDestroyed()) {
    unlockWindow.setAlwaysOnTop(true, 'screen-saver')
    unlockWindow.show()
    unlockWindow.focus()
    return
  }

  const win = new BrowserWindow({
    width: 420,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    title: '墨匣 Moxia - PocketAI — 解锁',
    // 解锁时库可能还没打开：windowBackground() 读不到 KV 会退回深色，不阻断解锁流程
    backgroundColor: windowBackground(),
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/unlock.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  unlockWindow = win

  // 解锁窗是启动期强制模态（关闭即退出）：置顶 + 抢焦点，
  // 防止被终端/其他窗口遮挡导致用户误以为「启动后没窗口」
  win.setAlwaysOnTop(true, 'screen-saver')

  const load = () => {
    if (process.env['ELECTRON_RENDERER_URL']) {
      // dev：Vite 服务器 URL 是 http://localhost:5173/ ，用 URL 替换 pathname
      const base = new URL(process.env['ELECTRON_RENDERER_URL'])
      base.pathname = '/unlock.html'
      base.search = `?mode=${mode}`
      win.loadURL(base.toString())
    } else {
      win.loadFile(path.join(__dirname, '../renderer/unlock.html'), { query: { mode } })
    }
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
    // 这句话只能在真正显示之后说。此前它打在 loadURL 之后、show 之前——窗口明明没出现，
    // 日志却断言「已弹出」（2026-11-08 那次误导排查的就是它）。
    log.info('解锁窗已显示（屏幕置顶），请输入主密码；主窗口将在解锁后打开')
  })

  // 锁屏窗口同样收口外链
  denyNewWindows(win.webContents)
  installLoadRetry(win, '解锁窗', load)
  installShowFallback(win, '解锁窗')
  load()

  // 解锁窗口关闭 = 用户放弃（启动期解锁是强制的，app 退出）
  win.on('closed', () => {
    unlockWindow = null
    if (options.quitOnClose) {
      unlockCoordinator.cancel()
      app.quit()
    }
  })
}

/**
 * 主动关闭解锁窗（解锁成功/换窗口）。主动关闭不得触发「关窗＝放弃」那条分支——
 * boot 成功解锁时主窗口还没创建，那条分支会当场 app.quit()。
 */
export function closeUnlockWindow(): void {
  const win = unlockWindow
  unlockWindow = null
  if (!win || win.isDestroyed()) return
  win.removeAllListeners('closed')
  win.close()
}
