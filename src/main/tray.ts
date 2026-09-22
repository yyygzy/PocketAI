// 系统托盘（Tray）
//
// 提供任务栏右下角的常驻图标 + 右键菜单（显示主窗口 / 退出）+
// 单击切换主窗口可见性。语言切换由 setTrayLang() 触发重建菜单。
//
// 设计要点：
// - 只在主窗口创建后初始化一次（boot 阶段 5 之后调用 initTray）
// - 退出时（will-quit）必须 destroy，否则 Windows 上残留图标
// - icon 用 32px PNG（托盘最佳尺寸；过大被系统缩放发糊）
// - 不拦截主窗口 close 事件：用户点关闭按钮仍走 window-all-closed → app.quit
//   的原路径，托盘只在应用运行期间提供快捷入口
import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron'
import path from 'node:path'
import { requestQuit } from './quit-manager'
import type { MenuLang } from './menu'

let tray: Tray | null = null
let lang: MenuLang = 'zh'

function labelText(zh: string, en: string): string {
  return lang !== 'en' ? zh : en
}

function findMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

function rebuildMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    {
      label: labelText('显示主窗口', 'Show main window'),
      click: () => {
        const win = findMainWindow()
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    },
    { type: 'separator' },
    {
      label: labelText('退出墨匣', 'Quit Moxia'),
      click: () => requestQuit()
    }
  ])
  tray.setContextMenu(contextMenu)
}

/** 初始化系统托盘（主窗口创建后调用一次） */
export function initTray(currentLang: MenuLang): void {
  if (tray) return // 防止重复初始化
  lang = currentLang
  // 用 icon-256.png 做源，nativeImage 自动按 DPI 缩放到 16/32/48px，保证高清屏不糊
  const iconPath = path.join(app.getAppPath(), 'build/icon/icon-256.png')
  const img = nativeImage.createFromPath(iconPath)
  if (img.isEmpty()) {
    console.warn('[tray] icon not found, skip tray init:', iconPath)
    return
  }
  tray = new Tray(img)
  tray.setToolTip('墨匣')
  rebuildMenu()
  // 单击 = 切换主窗口可见性（Windows 常见交互）
  tray.on('click', () => {
    const win = findMainWindow()
    if (!win) return
    if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
      win.hide()
    } else {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

/** 切换托盘菜单语言（与 buildAppLang 联动） */
export function setTrayLang(newLang: MenuLang): void {
  lang = newLang
  rebuildMenu()
}

/** 销毁托盘（app will-quit 时调用） */
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
