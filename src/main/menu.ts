// 应用菜单：中英文文案随渲染进程语言切换（IPC 上报）
import { app, Menu, dialog, BrowserWindow, nativeImage, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'

export type MenuLang = 'zh' | 'en'

function buildTemplate(lang: MenuLang): MenuItemConstructorOptions[] {
  const zh = lang !== 'en'
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  // macOS：设置原生 About 面板的自定义 icon（Windows 的 About 走 showMessageBox，已带 icon）
  if (isMac) {
    const iconPath = path.join(app.getAppPath(), 'build/icon/icon-256.png')
    app.setAboutPanelOptions({
      iconPath,
      applicationName: '墨匣',
      applicationVersion: app.getVersion(),
      copyright: zh ? '本地优先 · 便携 · 加密' : 'Local-first · Portable · Encrypted'
    })
  }

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: zh ? '关于墨匣' : 'About Moxia' },
        { type: 'separator' },
        { role: 'hide', label: zh ? '隐藏墨匣' : 'Hide Moxia' },
        { role: 'hideOthers', label: zh ? '隐藏其他' : 'Hide Others' },
        { role: 'unhide', label: zh ? '全部显示' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: zh ? '退出墨匣' : 'Quit Moxia' }
      ]
    })
  }

  template.push(
    {
      label: zh ? '文件' : 'File',
      submenu: [isMac ? { role: 'close' as const, label: zh ? '关闭窗口' : 'Close Window' } : { role: 'quit' as const, label: zh ? '退出' : 'Exit' }]
    },
    {
      label: zh ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: zh ? '撤销' : 'Undo' },
        { role: 'redo', label: zh ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: zh ? '剪切' : 'Cut' },
        { role: 'copy', label: zh ? '复制' : 'Copy' },
        { role: 'paste', label: zh ? '粘贴' : 'Paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const, label: zh ? '粘贴并匹配样式' : 'Paste and Match Style' },
              { role: 'delete' as const, label: zh ? '删除' : 'Delete' }
            ]
          : []),
        { role: 'selectAll', label: zh ? '全选' : 'Select All' }
      ]
    },
    {
      label: zh ? '视图' : 'View',
      submenu: [
        { role: 'reload', label: zh ? '重新加载' : 'Reload' },
        { role: 'forceReload', label: zh ? '强制重新加载' : 'Force Reload' },
        { role: 'toggleDevTools', label: zh ? '开发者工具' : 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: zh ? '实际大小' : 'Actual Size' },
        { role: 'zoomIn', label: zh ? '放大' : 'Zoom In' },
        { role: 'zoomOut', label: zh ? '缩小' : 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: zh ? '进入/退出全屏' : 'Toggle Full Screen' }
      ]
    },
    {
      label: zh ? '窗口' : 'Window',
      submenu: [
        { role: 'minimize', label: zh ? '最小化' : 'Minimize' },
        ...(isMac
          ? [{ role: 'zoom' as const, label: zh ? '缩放' : 'Zoom' }, { type: 'separator' } as MenuItemConstructorOptions, { role: 'front' as const, label: zh ? '前置全部窗口' : 'Bring All to Front' }]
          : [{ role: 'close' as const, label: zh ? '关闭窗口' : 'Close Window' }])
      ]
    },
    {
      role: 'help',
      label: zh ? '帮助' : 'Help',
      submenu: [
        {
          label: zh ? '关于墨匣' : 'About Moxia',
          click: () => {
            const iconPath = path.join(app.getAppPath(), 'build/icon/icon-512.png')
            const opts = {
              type: 'info' as const,
              title: '墨匣 Moxia - PocketAI',
              message: `墨匣 v${app.getVersion()}`,
              detail: zh
                ? '本地优先的 AI 工作站 · 便携 · 加密'
                : 'Local-first AI workstation · Portable · Encrypted',
              icon: nativeImage.createFromPath(iconPath),
              buttons: [zh ? '好的' : 'OK']
            }
            const focused = BrowserWindow.getFocusedWindow()
            if (focused) dialog.showMessageBox(focused, opts)
            else dialog.showMessageBox(opts)
          }
        }
      ]
    }
  )

  return template
}

/** 构建 / 重建应用菜单 */
export function buildAppMenu(lang: MenuLang): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(lang)))
}
