// 应用菜单：macOS 保留完整菜单（系统惯例）；Windows/Linux 菜单栏整行去掉（用户要求），
// 由 buildAppMenu 直接 setApplicationMenu(null)，开发用 F12 兜底（见 index.ts before-input-event）。
import { app, Menu, type MenuItemConstructorOptions } from 'electron'
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

  // 非 macOS 不会走到这里（buildAppMenu 已提前 setApplicationMenu(null)）；
  // 防御一下：返回空模板而不是去 set 菜单（本函数只管模板，不碰 Menu 状态）
  if (process.platform !== 'darwin') return template

  // macOS：无菜单栏不符合系统惯例，保留完整菜单
  template.push(
    {
      label: zh ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: zh ? '撤销' : 'Undo' },
        { role: 'redo', label: zh ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: zh ? '剪切' : 'Cut' },
        { role: 'copy', label: zh ? '复制' : 'Copy' },
        { role: 'paste', label: zh ? '粘贴' : 'Paste' },
        { role: 'pasteAndMatchStyle' as const, label: zh ? '粘贴并匹配样式' : 'Paste and Match Style' },
        { role: 'delete' as const, label: zh ? '删除' : 'Delete' },
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
        { role: 'zoom' as const, label: zh ? '缩放' : 'Zoom' },
        { type: 'separator' as const },
        { role: 'front' as const, label: zh ? '前置全部窗口' : 'Bring All to Front' }
      ]
    },
    {
      label: zh ? '帮助' : 'Help',
      submenu: [
        { role: 'about', label: zh ? '关于墨匣' : 'About Moxia' }
      ]
    }
  )

  return template
}

/** 构建 / 重建应用菜单 */
export function buildAppMenu(lang: MenuLang): void {
  void lang
  if (process.platform !== 'darwin') {
    // 菜单栏整行去掉：setApplicationMenu(null) 后窗口内容直接顶到标题栏下沿
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(lang)))
}
