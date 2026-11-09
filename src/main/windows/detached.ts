// 独立窗口（标签弹出）：与主窗口共用 index.html 入口，#/detached?module=xxx hash 分流
// 放独立模块避免 index.ts ↔ ipc/index.ts 循环依赖
import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import { lockService } from '../lock/lock'
import { denyNewWindows } from '../net/external-links'
import { markThemedWindow, windowBackground } from '../ui-preferences'

/** 模块白名单：独立窗口只允许打开这些模块（settings/steward 不允许弹出） */
export const DETACHED_MODULES = new Set([
  'chat', 'skills', 'knowledge', 'files', 'notes', 'translate', 'image', 'sandbox'
])

/** 创建独立窗口渲染指定模块 */
export function createDetachedWindow(moduleId: string): void {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: windowBackground(),
    title: '墨匣 Moxia - PocketAI',
    icon: process.platform === 'win32'
      ? path.join(app.getAppPath(), 'build/icon/icon.ico')
      : path.join(__dirname, '../../build/icon/icon-256.png'),
    webPreferences: {
      // __dirname 是构建后的 out/main（见 package.json main 与 electron.vite.config.ts 的 outDir），
      // 与主窗口/浮窗/解锁窗同一口径只退一级；此前退两级会指向 <app>/preload/index.js（不存在），
      // preload 加载失败 ⇒ 本窗口 window.pocketai 缺失 ⇒ DetachedApp 挂载即崩。
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  // A-3：独立窗口与主窗口共用主题底色（切主题时一起刷新）
  markThemedWindow(win)
  win.on('ready-to-show', () => win.show())
  // 独立窗口同样不参与后台节流（后台任务 UI 不卡顿）
  win.webContents.setBackgroundThrottling(false)
  // 外链收口：与主窗口同策略，应用内拒开新窗
  denyNewWindows(win.webContents)
  // 锁屏联动：独立窗口隐藏/恢复同样上报（自动锁屏计时覆盖所有窗口）
  win.on('hide', () => lockService.onAppHidden())
  win.on('show', () => lockService.onAppShown())
  win.on('minimize', () => lockService.onAppHidden())
  win.on('restore', () => lockService.onAppShown())
  win.on('closed', () => { /* 关闭即销毁，不合并回主窗口 */ })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#/detached?module=${moduleId}`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      hash: `/detached?module=${moduleId}`
    })
  }
}
