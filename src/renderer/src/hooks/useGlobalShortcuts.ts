// 应用内全局快捷键中枢：window keydown 唯一注册点（App 挂载一次）
// - 标签/窗口类动作直接操作 store / IPC
// - 会话类动作通过 CustomEvent 派发给当前活动实例（ChatModule / AgentPanel 自行守卫活动态）
import { useEffect } from 'react'
import { matchAppShortcut, type AppShortcutId, type ConversationShortcutAction } from '../utils/shortcuts'
import { useAppStore } from '../store/app-store'
import { reportIpcError } from '../utils/ipc'

/** 会话类快捷键事件名 */
export const APP_SHORTCUT_EVENT = 'pai:app-shortcut'

/** 命令面板开关事件名（CommandPalette 常驻监听） */
export const COMMAND_PALETTE_EVENT = 'pai:command-palette'

export type AppShortcutEventDetail = { action: ConversationShortcutAction }

/** 响应会话类快捷键的模块 */
const CONV_MODULES = new Set(['chat', 'agent'])

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useAppStore.getState()
      // 锁屏期间全部快捷键不响应（内容区已 inert，此处再守一道）
      if (s.locked) return
      // 活动模块是否流式运行中（busy 由 ChatModule / AgentPanel 上报）
      const running = s.busyModules[s.activeModule] === true
      const m = matchAppShortcut(e, { running })
      if (!m) return

      switch (m.id) {
        case 'tab': {
          const tb = s.tabs[m.tabIndex! - 1]
          if (!tb) return // 超出标签数：无动作
          e.preventDefault()
          s.setActiveTabId(tb.id)
          break
        }
        case 'closeTab':
          e.preventDefault() // 防浏览器/Electron 默认关窗
          s.closeTab(s.activeTabId)
          break
        case 'openSettings':
          e.preventDefault()
          s.switchModule('settings')
          break
        case 'lock':
          e.preventDefault()
          window.pocketai.lock().catch(reportIpcError('app.lock'))
          break
        case 'commandPalette':
          // 任意模块均可呼出（面板内自行加载数据源）；编辑态同样拦截浏览器打印
          e.preventDefault()
          window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT))
          break
        case 'newConv':
        case 'focusSearch':
        case 'focusComposer':
        case 'abort': {
          if (!CONV_MODULES.has(s.activeModule)) return
          e.preventDefault()
          const detail: AppShortcutEventDetail = { action: m.id as ConversationShortcutAction }
          window.dispatchEvent(new CustomEvent<AppShortcutEventDetail>(APP_SHORTCUT_EVENT, { detail }))
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** 活动模块实例守卫：保活隐藏实例 / 同模块非活动实例不得响应会话类快捷键 */
export function isActiveModuleInstance(moduleId: 'chat' | 'agent'): boolean {
  return document.querySelector(`[data-active-module="${moduleId}"]`) !== null
}

/** 快捷键动作类型重导出（供监听方使用） */
export type { AppShortcutId }
