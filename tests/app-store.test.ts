// app-store 导航逻辑测试（侧栏为唯一导航：保活 LRU / 固定豁免 / 顺序清洗）
//
// V4-Iter-112 起 store 不再管标签页，也不再走 zustand persist（固定列表与侧栏顺序都存 app_config），
// 所以这里不需要 stub localStorage + 动态 import：直接 setState 复位即可。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAppStore,
  evictMounted,
  normalizePinnedModules,
  normalizeSidebarOrder,
  MAX_KEPT_MODULES,
  MAX_PINNED_MODULES
} from '../src/renderer/src/store/app-store'
import { DEFAULT_SIDEBAR_ORDER } from '../src/shared/types'
import type { ModuleId } from '../src/renderer/src/components/Sidebar'

const FRESH = {
  activeModule: 'chat' as ModuleId,
  mountedModules: ['chat'] as ModuleId[],
  busyModules: {} as Partial<Record<ModuleId, boolean>>,
  pinnedModules: [] as ModuleId[],
  sidebarOrder: [...DEFAULT_SIDEBAR_ORDER]
}

beforeEach(() => {
  useAppStore.setState({ ...FRESH })
})

/** 模拟 App 的 effect：switchModule 之后 touchModule 记 LRU（真实环境由 activeModule 变化驱动） */
function goto(id: ModuleId): void {
  const s = useAppStore.getState()
  s.switchModule(id)
  s.touchModule(id)
}

const mounted = () => useAppStore.getState().mountedModules

describe('evictMounted — LRU 休眠淘汰', () => {
  it('未超阈值原样返回', () => {
    expect(evictMounted(['a', 'b'], { activeId: 'b', pinnedIds: [], busyIds: [], max: 4 })).toEqual(['a', 'b'])
  })

  it('超阈值淘汰 LRU 尾部，active 即使在尾部也豁免', () => {
    // 头部最近访问；active 'e' 在最尾，扫描时跳过 e，先淘汰 d
    expect(evictMounted(['a', 'b', 'c', 'd', 'e'], { activeId: 'e', pinnedIds: [], busyIds: [], max: 4 }))
      .toEqual(['a', 'b', 'c', 'e'])
  })

  it('pinned 与 busy 模块豁免；全部受保护时宁超阈值不淘汰', () => {
    // d pinned、e busy、a active → 只需淘汰 1 个：尾部扫描 e 跳、d 跳、c 淘汰
    expect(evictMounted(['a', 'b', 'c', 'd', 'e'], { activeId: 'a', pinnedIds: ['d'], busyIds: ['e'], max: 4 }))
      .toEqual(['a', 'b', 'd', 'e'])
    expect(
      evictMounted(['a', 'b', 'c', 'd', 'e'], { activeId: 'a', pinnedIds: ['b', 'c'], busyIds: ['d', 'e'], max: 4 })
    ).toHaveLength(5)
  })
})

describe('导航偏好清洗（库里可能是脏值）', () => {
  it('normalizePinnedModules：剔非法模块 id、去重、截断到上限', () => {
    expect(normalizePinnedModules(['chat', 'chat', 'nope', 42, 'settings'])).toEqual(['chat', 'settings'])
    const many = DEFAULT_SIDEBAR_ORDER.slice(0, MAX_PINNED_MODULES + 2)
    expect(normalizePinnedModules(many)).toHaveLength(MAX_PINNED_MODULES)
    // 非数组（KV 被写坏）→ 空列表而不是抛
    expect(normalizePinnedModules('chat')).toEqual([])
    expect(normalizePinnedModules(null)).toEqual([])
  })

  it('normalizeSidebarOrder：完整排列通过；缺项/重复/脏值整体回默认', () => {
    const swapped = [...DEFAULT_SIDEBAR_ORDER]
    swapped.reverse()
    expect(normalizeSidebarOrder(swapped)).toEqual(swapped)
    expect(normalizeSidebarOrder(swapped.slice(1))).toEqual(DEFAULT_SIDEBAR_ORDER)
    // 同长度但含重复项（缺 chat、agent 出现两次）——只有去重那道检查挡得住
    const dup = DEFAULT_SIDEBAR_ORDER.map((m, i) => (i === 0 ? DEFAULT_SIDEBAR_ORDER[1]! : m))
    expect(dup).toHaveLength(DEFAULT_SIDEBAR_ORDER.length)
    expect(normalizeSidebarOrder(dup)).toEqual(DEFAULT_SIDEBAR_ORDER)
    expect(normalizeSidebarOrder([...DEFAULT_SIDEBAR_ORDER.slice(1), 'chat', 'chat'])).toEqual(DEFAULT_SIDEBAR_ORDER)
    // 同长度但含非法项：过滤后变短，也必须整体回默认（不能让侧栏少一项还照常显示）
    const withJunk = DEFAULT_SIDEBAR_ORDER.map((m, i) => (i === 0 ? 'nope' : m)) as unknown as string[]
    expect(withJunk).toHaveLength(DEFAULT_SIDEBAR_ORDER.length)
    expect(normalizeSidebarOrder(withJunk)).toEqual(DEFAULT_SIDEBAR_ORDER)
    expect(normalizeSidebarOrder(undefined)).toEqual(DEFAULT_SIDEBAR_ORDER)
  })
})

describe('模块切换与保活', () => {
  it('switchModule 只改活动模块，不再产生任何"标签"副作用', () => {
    goto('settings')
    goto('settings')
    const s = useAppStore.getState()
    expect(s.activeModule).toBe('settings')
    // 同模块二次进入不该在保活列表里出现两份
    expect(mounted().filter((m) => m === 'settings')).toHaveLength(1)
  })

  it('touchModule：新模块插入 LRU 头部，重复 touch 只移到头部', () => {
    goto('settings')
    goto('knowledge')
    expect(mounted()).toEqual(['knowledge', 'settings', 'chat'])
    useAppStore.getState().touchModule('settings')
    expect(mounted()).toEqual(['settings', 'knowledge', 'chat'])
  })

  it('挂载数超 MAX_KEPT_MODULES 时淘汰最久未访问模块', () => {
    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) goto(id)
    expect(mounted()).toHaveLength(MAX_KEPT_MODULES)
    expect(mounted()).toEqual(['notes', 'files', 'knowledge', 'settings'])
    expect(mounted()).not.toContain('chat')
  })

  it('固定的模块豁免休眠；取消固定后补一次淘汰', () => {
    useAppStore.getState().setPinnedModules(['chat'])
    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) goto(id)
    // chat 虽最久未访问但被固定豁免；被淘汰的是 settings
    expect(mounted()).toContain('chat')
    expect(mounted()).not.toContain('settings')
    expect(mounted()).toHaveLength(MAX_KEPT_MODULES)

    useAppStore.getState().toggleModulePinned('chat')
    expect(useAppStore.getState().pinnedModules).toEqual([])
    // 取消固定不会立刻把模块踢出去：保活集合没超上限就无需重排，
    // 它会在下一次有模块进来时被 LRU 淘汰（"取消固定"是解除豁免，不是马上卸载）
    expect(mounted()).toContain('chat')
    goto('translate')
    expect(mounted()).toHaveLength(MAX_KEPT_MODULES)
    expect(mounted()).not.toContain('chat')
  })

  it('toggleModulePinned 超上限时按清洗规则截断（固定不进去就是固定不进去）', () => {
    const five = DEFAULT_SIDEBAR_ORDER.slice(0, MAX_PINNED_MODULES + 1)
    useAppStore.getState().setPinnedModules(five)
    expect(useAppStore.getState().pinnedModules).toEqual(five.slice(0, MAX_PINNED_MODULES))
    useAppStore.getState().toggleModulePinned(five[MAX_PINNED_MODULES]!)
    const after = useAppStore.getState().pinnedModules
    expect(after).toHaveLength(MAX_PINNED_MODULES)
    expect(after).not.toContain(five[MAX_PINNED_MODULES])
  })

  it('busy 模块豁免休眠；busy 解除后下一次更新补淘汰', () => {
    const s = () => useAppStore.getState()
    s().setModuleBusy('chat', true)
    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) {
      goto(id)
      s().setModuleBusy(id, true)
    }
    expect(mounted()).toHaveLength(5) // 全部受保护，宁超阈值不淘汰
    expect(mounted()).toContain('chat')

    s().setModuleBusy('chat', false)
    expect(mounted()).toHaveLength(MAX_KEPT_MODULES)
    expect(mounted()).not.toContain('chat')
  })

  it('侧栏顺序进 store（Ctrl+1..9 要按它绑定）', () => {
    const s = useAppStore.getState()
    const custom = [...DEFAULT_SIDEBAR_ORDER]
    custom.splice(0, 0, custom.splice(3, 1)[0]!)
    s.setSidebarOrder(custom)
    expect(useAppStore.getState().sidebarOrder).toEqual(custom)
    expect(useAppStore.getState().sidebarOrder[0]).toBe(custom[0])
  })
})
