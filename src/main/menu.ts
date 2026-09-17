// 应用菜单：中英文文案随渲染进程语言切换（IPC 上报）
import { app, Menu, dialog, type MenuItemConstructorOptions } from 'electron'

export type MenuLang = 'zh' | 'en'

function buildTemplate(lang: MenuLang): MenuItemConstructorOptions[] {
  const zh = lang !== 'en'
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: zh ? '关于 PocketAI' : 'About PocketAI' },
        { type: 'separator' },
        { role: 'hide', label: zh ? '隐藏 PocketAI' : 'Hide PocketAI' },
        { role: 'hideOthers', label: zh ? '隐藏其他' : 'Hide Others' },
        { role: 'unhide', label: zh ? '全部显示' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: zh ? '退出 PocketAI' : 'Quit PocketAI' }
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
          label: zh ? '关于 PocketAI' : 'About PocketAI',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'PocketAI',
              message: `PocketAI v${app.getVersion()}`,
              detail: zh
                ? '本地优先的 AI 工作站 · 便携 · 加密'
                : 'Local-first AI workstation · Portable · Encrypted',
              buttons: [zh ? '好的' : 'OK']
            })
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
