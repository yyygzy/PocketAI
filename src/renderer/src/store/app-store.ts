// 全局应用状态：收敛 App.tsx 中的跨模块状态
// - 标签/模块导航：替代 window 事件总线，任意模块可直接 switchModule
// - 锁屏状态：任意模块可读取 locked/dbEncrypted，无需 prop 钻取
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModuleId } from '../components/Sidebar'
import type { Tab } from '../components/TabBar'
import type { WizardVariant } from '../modules/wizard/FirstRunWizard'

const TABS_STORAGE_KEY = 'pocketai.tabs.v1'

let tabCounter = 0
const newTabId = () => `tab-${Date.now()}-${++tabCounter}`

/** 初始标签布局（persist 未命中时的兜底） */
function initialTabs(): { tabs: Tab[]; activeTabId: string } {
  const tab: Tab = { id: newTabId(), title: '新对话', moduleId: 'chat' }
  return { tabs: [tab], activeTabId: tab.id }
}

interface AppState {
  // ─── 模块 & 标签 ───
  activeModule: ModuleId
  tabs: Tab[]
  activeTabId: string
  setActiveModule: (id: ModuleId) => void
  setActiveTabId: (id: string) => void
  /** 切换模块：已有该模块标签则激活，否则新建（title 为 i18n 后的标签标题） */
  switchModule: (id: ModuleId, title?: string) => void
  newTab: (title?: string) => void
  closeTab: (id: string) => void
  reorderTabs: (fromId: string, toId: string) => void
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
  /** 弹出到独立窗口后关闭本标签（由 App 调用，因需 IPC） */
  removeTabAfterPopOut: (id: string) => void

  // ─── 锁屏 ───
  locked: boolean
  dbEncrypted: boolean
  setLocked: (v: boolean) => void
  setDbEncrypted: (v: boolean) => void

  // ─── 首启向导 ───
  wizard: WizardVariant | null
  setWizard: (v: WizardVariant | null) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      activeModule: 'chat',
      ...(() => {
        const { tabs, activeTabId } = initialTabs()
        return { tabs, activeTabId }
      })(),

      setActiveModule: (id) => set({ activeModule: id }),

      setActiveTabId: (id) =>
        set((state) => {
          // 选中标签时同步高亮对应模块（侧边栏跟随）
          const tab = state.tabs.find((tb) => tb.id === id)
          return tab ? { activeTabId: id, activeModule: tab.moduleId as ModuleId } : { activeTabId: id }
        }),

      switchModule: (id, title) => {
        const { tabs } = get()
        const existing = tabs.find((tb) => tb.moduleId === id)
        if (existing) {
          set({ activeModule: id, activeTabId: existing.id })
        } else {
          const tab: Tab = { id: newTabId(), title: title ?? id, moduleId: id }
          set({ activeModule: id, tabs: [...tabs, tab], activeTabId: tab.id })
        }
      },

      newTab: (title) => {
        const { activeModule, tabs } = get()
        const tab: Tab = { id: newTabId(), title: title ?? activeModule, moduleId: activeModule }
        set({ tabs: [...tabs, tab], activeTabId: tab.id })
      },

      closeTab: (id) => {
        set((state) => {
          const next = state.tabs.filter((tb) => tb.id !== id)
          let nextActive = state.activeTabId
          if (id === state.activeTabId && next.length > 0) {
            nextActive = next[next.length - 1]!.id
          }
          if (next.length === 0) {
            const tb: Tab = { id: newTabId(), title: '新对话', moduleId: 'chat' }
            return { tabs: [tb], activeTabId: tb.id }
          }
          return { tabs: next, activeTabId: nextActive }
        })
      },

      reorderTabs: (fromId, toId) => {
        set((state) => {
          const from = state.tabs.findIndex((tb) => tb.id === fromId)
          const to = state.tabs.findIndex((tb) => tb.id === toId)
          if (from < 0 || to < 0 || from === to) return state
          const next = [...state.tabs]
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved!)
          const pinned = next.filter((tb) => tb.pinned)
          const normal = next.filter((tb) => !tb.pinned)
          return { tabs: pinned.length > 0 ? [...pinned, ...normal] : next }
        })
      },

      closeOthers: (id) => {
        set((state) => {
          const keep = state.tabs.filter((tb) => tb.id === id || tb.pinned)
          const activeTabId = keep.some((tb) => tb.id === state.activeTabId) ? state.activeTabId : id
          return { tabs: keep, activeTabId }
        })
      },

      closeRight: (id) => {
        set((state) => {
          const idx = state.tabs.findIndex((tb) => tb.id === id)
          if (idx < 0) return state
          const keep = state.tabs.filter((tb, i) => i <= idx || tb.pinned)
          const activeTabId = keep.some((tb) => tb.id === state.activeTabId) ? state.activeTabId : id
          return { tabs: keep, activeTabId }
        })
      },

      removeTabAfterPopOut: (id) => get().closeTab(id),

      locked: false,
      dbEncrypted: false,
      setLocked: (v) => set({ locked: v }),
      setDbEncrypted: (v) => set({ dbEncrypted: v }),

      wizard: null,
      setWizard: (v) => set({ wizard: v }),
    }),
    {
      name: TABS_STORAGE_KEY,
      // 仅持久化标签布局；锁屏/向导/当前模块属于会话态，不持久化
      partialize: (state) => ({
        tabs: state.tabs.map((tb) => ({ moduleId: tb.moduleId, title: tb.title, pinned: tb.pinned })),
        activeTabId: state.tabs.findIndex((tb) => tb.id === state.activeTabId),
      }),
      // 反序列化时重建 id 并还原 activeTabId
      merge: (persisted, current) => {
        const p = persisted as { tabs?: Array<{ moduleId: string; title: string; pinned?: boolean }>; activeTabId?: number }
        if (!p.tabs || p.tabs.length === 0) return current
        const tabs = p.tabs
          .filter((x) => x && typeof x.moduleId === 'string' && typeof x.title === 'string')
          .slice(0, 20)
          .map((x) => ({ id: newTabId(), moduleId: x.moduleId, title: x.title, pinned: x.pinned }))
        const idx = typeof p.activeTabId === 'number' && p.activeTabId >= 0 && p.activeTabId < tabs.length
          ? p.activeTabId
          : 0
        return { ...current, tabs, activeTabId: tabs[idx]!.id }
      },
    }
  )
)
