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

/** 同时保活（挂载但隐藏）的模块数上限；超出后 LRU 尾部进入 dormant（卸载渲染） */
export const MAX_KEPT_MODULES = 4

/** pinned 标签前置（保持 pinned 组与普通组各自的相对顺序）；无 pinned 时原样返回 */
export function pinFirst(tabs: Tab[]): Tab[] {
  const pinned = tabs.filter((tb) => tb.pinned)
  if (pinned.length === 0) return tabs
  const normal = tabs.filter((tb) => !tb.pinned)
  return [...pinned, ...normal]
}

export interface EvictCtx {
  /** 当前活动模块，永不淘汰 */
  activeId: string
  /** 拥有 pinned 标签的模块，豁免淘汰 */
  pinnedIds: string[]
  /** 任务运行中（流式等）的模块，豁免淘汰 */
  busyIds: string[]
  max: number
}

/**
 * LRU 休眠淘汰：mounted 头部为最近访问。
 * 总数超 max 时，从非保护候选的尾部（最久未访问）逐个淘汰；
 * busy 模块占名额但不被淘汰——宁可多占内存也不中断流式。
 */
export function evictMounted<T extends string>(mounted: T[], ctx: EvictCtx): T[] {
  if (mounted.length <= ctx.max) return mounted
  const protectedIds = new Set([ctx.activeId, ...ctx.pinnedIds, ...ctx.busyIds])
  const result = [...mounted]
  for (let i = result.length - 1; i >= 0 && result.length > ctx.max; i--) {
    if (!protectedIds.has(result[i]!)) result.splice(i, 1)
  }
  return result
}

/**
 * 关闭标签后收敛保活列表：移除已无标签的模块（卸载孤儿挂载），
 * 并保证新活动模块在列（保持其余模块 LRU 顺序）。
 */
export function reconcileMounted<T extends string>(mounted: T[], tabs: Tab[], activeModule: T): T[] {
  const tabModules = new Set(tabs.map((tb) => tb.moduleId))
  return [activeModule, ...mounted.filter((m) => m !== activeModule && tabModules.has(m))]
}

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
  /** 已挂载（保活中）的模块，LRU 顺序：头部最近访问；不持久化 */
  mountedModules: ModuleId[]
  /** 任务运行中（流式等）的模块标记，休眠时豁免；不持久化 */
  busyModules: Partial<Record<ModuleId, boolean>>
  setActiveModule: (id: ModuleId) => void
  setActiveTabId: (id: string) => void
  /** 切换模块：已有该模块标签则激活，否则新建（title 为 i18n 后的标签标题） */
  switchModule: (id: ModuleId, title?: string) => void
  newTab: (title?: string) => void
  closeTab: (id: string) => void
  reorderTabs: (fromId: string, toId: string) => void
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
  /** 固定/取消固定标签（固定标签前置且不可休眠） */
  togglePin: (id: string) => void
  /** 模块被激活（标签切换）时更新 LRU 并执行休眠淘汰 */
  touchModule: (id: ModuleId) => void
  /** 模块上报忙碌状态（流式开始/结束）；busy 解除时补做淘汰 */
  setModuleBusy: (id: ModuleId, busy: boolean) => void
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
      mountedModules: ['chat'],
      busyModules: {},

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
            return { tabs: [tb], activeTabId: tb.id, activeModule: 'chat', mountedModules: ['chat'] as ModuleId[] }
          }
          const activeMod = (next.find((tb) => tb.id === nextActive)?.moduleId ?? 'chat') as ModuleId
          return {
            tabs: next,
            activeTabId: nextActive,
            activeModule: activeMod,
            mountedModules: reconcileMounted(state.mountedModules, next, activeMod)
          }
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
          return { tabs: pinFirst(next) }
        })
      },

      togglePin: (id) =>
        set((state) => ({
          tabs: pinFirst(state.tabs.map((tb) => (tb.id === id ? { ...tb, pinned: !tb.pinned } : tb)))
        })),

      touchModule: (id) =>
        set((state) => {
          const next: ModuleId[] = [id, ...state.mountedModules.filter((m) => m !== id)]
          const pinnedIds = state.tabs.filter((tb) => tb.pinned).map((tb) => tb.moduleId)
          const busyIds = Object.entries(state.busyModules)
            .filter(([, v]) => v)
            .map(([k]) => k)
          return {
            mountedModules: evictMounted(next, {
              activeId: state.activeModule,
              pinnedIds,
              busyIds,
              max: MAX_KEPT_MODULES
            })
          }
        }),

      setModuleBusy: (id, busy) =>
        set((state) => {
          const busyModules = { ...state.busyModules, [id]: busy }
          const pinnedIds = state.tabs.filter((tb) => tb.pinned).map((tb) => tb.moduleId)
          const busyIds = Object.entries(busyModules)
            .filter(([, v]) => v)
            .map(([k]) => k)
          return {
            busyModules,
            // busy 解除时尝试补淘汰；busy 置位时淘汰结果不变（仅多一个豁免）
            mountedModules: evictMounted(state.mountedModules, {
              activeId: state.activeModule,
              pinnedIds,
              busyIds,
              max: MAX_KEPT_MODULES
            })
          }
        }),

      closeOthers: (id) => {
        set((state) => {
          const keep = state.tabs.filter((tb) => tb.id === id || tb.pinned)
          const activeTabId = keep.some((tb) => tb.id === state.activeTabId) ? state.activeTabId : id
          const activeMod = (keep.find((tb) => tb.id === activeTabId)?.moduleId ?? 'chat') as ModuleId
          return {
            tabs: keep,
            activeTabId,
            activeModule: activeMod,
            mountedModules: reconcileMounted(state.mountedModules, keep, activeMod)
          }
        })
      },

      closeRight: (id) => {
        set((state) => {
          const idx = state.tabs.findIndex((tb) => tb.id === id)
          if (idx < 0) return state
          const keep = state.tabs.filter((tb, i) => i <= idx || tb.pinned)
          const activeTabId = keep.some((tb) => tb.id === state.activeTabId) ? state.activeTabId : id
          const activeMod = (keep.find((tb) => tb.id === activeTabId)?.moduleId ?? 'chat') as ModuleId
          return {
            tabs: keep,
            activeTabId,
            activeModule: activeMod,
            mountedModules: reconcileMounted(state.mountedModules, keep, activeMod)
          }
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
        // 重启后只挂载活动模块，其余按需恢复保活（mountedModules/busyModules 属会话态不持久化）
        const activeMod = tabs[idx]!.moduleId as ModuleId
        return {
          ...current,
          tabs,
          activeTabId: tabs[idx]!.id,
          activeModule: activeMod,
          mountedModules: [activeMod],
          busyModules: {}
        }
      },
    }
  )
)
