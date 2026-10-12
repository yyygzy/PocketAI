// 全局应用状态：跨模块导航（当前模块 / 保活 LRU / 固定 / 侧栏顺序）+ 锁屏 + 首启向导
//
// 这里曾管着一套「标签页」（tabs / activeTabId / 关闭·重排·固定标签），V4-Iter-112 整体下线。
// 原因是标签从不携带实例状态：Tab 只有 {id,title,moduleId,pinned}，而 Workspace 按 moduleId
// 挂载组件 ⇒ 同一模块的两个标签渲染的是同一个界面、同一份会话，策划书里「侧栏切模块，标签切实例」
// 的分工从未成立。标签独有的两个动作（弹出独立窗口、不被休眠）搬到侧栏模块项的右键菜单。
// 固定列表与侧栏顺序都存 app_config（随便携目录走），故本 store 不再用 zustand persist。
import { create } from 'zustand'
import type { ModuleId } from '../components/Sidebar'
import type { WizardVariant } from '../modules/wizard/FirstRunWizard'
import { DEFAULT_SIDEBAR_ORDER } from '../../../shared/types'

/** 同时保活（挂载但隐藏）的模块数上限；超出后 LRU 尾部进入 dormant（卸载渲染） */
export const MAX_KEPT_MODULES = 4

/** 可固定的模块数上限：固定数达到保活上限即等于全量豁免，LRU 失去意义 */
export const MAX_PINNED_MODULES = MAX_KEPT_MODULES

/** 清洗来自 app_config 的固定列表：只留合法模块 id、去重、截断到上限 */
export function normalizePinnedModules(raw: unknown): ModuleId[] {
  if (!Array.isArray(raw)) return []
  const out: ModuleId[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const id = x as ModuleId
    if (!DEFAULT_SIDEBAR_ORDER.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return out.slice(0, MAX_PINNED_MODULES)
}

/** 清洗侧栏顺序：必须是全部模块的一个排列，否则整体回默认（半截列表比没有列表更糟） */
export function normalizeSidebarOrder(raw: unknown): ModuleId[] {
  if (!Array.isArray(raw) || raw.length !== DEFAULT_SIDEBAR_ORDER.length) return [...DEFAULT_SIDEBAR_ORDER]
  const list = raw.filter(
    (x): x is ModuleId => typeof x === 'string' && DEFAULT_SIDEBAR_ORDER.includes(x as ModuleId)
  )
  if (list.length !== DEFAULT_SIDEBAR_ORDER.length || new Set(list).size !== list.length) {
    return [...DEFAULT_SIDEBAR_ORDER]
  }
  return list
}

export interface EvictCtx {
  /** 当前模块，永不淘汰 */
  activeId: string
  /** 被用户固定的模块，豁免淘汰 */
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

interface AppState {
  // ─── 模块导航 ───
  activeModule: ModuleId
  /** 已挂载（保活中）的模块，LRU 顺序：头部最近访问；不持久化 */
  mountedModules: ModuleId[]
  /** 任务运行中（流式等）的模块标记，休眠时豁免；不持久化 */
  busyModules: Partial<Record<ModuleId, boolean>>
  /** 固定不被休眠的模块（app_config: sidebar.pinned，由侧栏右键维护） */
  pinnedModules: ModuleId[]
  /**
   * 侧栏可见顺序（app_config: sidebar.order）。
   * 放在 store 而不是 Sidebar 局部状态，是因为 Ctrl+1..9 现在按"侧栏第 n 项"绑定，
   * 快捷键处理器读不到组件内部状态。
   */
  sidebarOrder: ModuleId[]

  /** 切换模块：侧栏 / 命令面板 / 快捷键的唯一入口（App 的 effect 负责随后 touchModule 记 LRU） */
  switchModule: (id: ModuleId) => void
  /** 模块被激活时更新 LRU 并执行休眠淘汰 */
  touchModule: (id: ModuleId) => void
  /** 模块上报忙碌状态（流式开始/结束）；busy 解除时补做淘汰 */
  setModuleBusy: (id: ModuleId, busy: boolean) => void
  toggleModulePinned: (id: ModuleId) => void
  /** 整体覆盖固定列表：读回 app_config 与保存失败回滚共用 */
  setPinnedModules: (list: ModuleId[]) => void
  setSidebarOrder: (list: ModuleId[]) => void

  // ─── 锁屏 ───
  locked: boolean
  dbEncrypted: boolean
  setLocked: (v: boolean) => void
  setDbEncrypted: (v: boolean) => void

  // ─── 首启向导 ───
  wizard: WizardVariant | null
  setWizard: (v: WizardVariant | null) => void
}

/** 按当前 pinned/busy 豁免重算保活集合（touch 与 busy 变更共用） */
function relayout(
  state: Pick<AppState, 'mountedModules' | 'pinnedModules' | 'busyModules'>,
  activeId: ModuleId
): ModuleId[] {
  const busyIds = Object.entries(state.busyModules)
    .filter(([, v]) => v)
    .map(([k]) => k)
  return evictMounted(state.mountedModules, {
    activeId,
    pinnedIds: state.pinnedModules,
    busyIds,
    max: MAX_KEPT_MODULES
  })
}

export const useAppStore = create<AppState>()((set, get) => ({
  activeModule: 'chat',
  mountedModules: ['chat'],
  busyModules: {},
  pinnedModules: [],
  sidebarOrder: [...DEFAULT_SIDEBAR_ORDER],

  switchModule: (id) => set({ activeModule: id }),

  touchModule: (id) =>
    set((state) => {
      const mountedModules = [id, ...state.mountedModules.filter((m) => m !== id)]
      return { mountedModules: relayout({ ...state, mountedModules }, id) }
    }),

  setModuleBusy: (id, busy) =>
    set((state) => {
      const busyModules = { ...state.busyModules, [id]: busy }
      return {
        busyModules,
        // busy 解除时尝试补淘汰；busy 置位时淘汰结果不变（仅多一个豁免）
        mountedModules: relayout({ ...state, busyModules }, state.activeModule)
      }
    }),

  setPinnedModules: (list) => {
    set((state) => {
      const pinnedModules = normalizePinnedModules(list)
      // 固定集合变大可能让保活数超上限（例如刚取消 busy 的模块被新豁免挤掉），补算一次
      const next = { ...state, pinnedModules }
      return { pinnedModules, mountedModules: relayout(next, state.activeModule) }
    })
  },

  toggleModulePinned: (id) => {
    const { pinnedModules, setPinnedModules } = get()
    setPinnedModules(
      pinnedModules.includes(id) ? pinnedModules.filter((m) => m !== id) : [...pinnedModules, id]
    )
  },

  setSidebarOrder: (list) => set({ sidebarOrder: normalizeSidebarOrder(list) }),

  locked: false,
  dbEncrypted: false,
  setLocked: (v) => set({ locked: v }),
  setDbEncrypted: (v) => set({ dbEncrypted: v }),

  wizard: null,
  setWizard: (v) => set({ wizard: v })
}))
