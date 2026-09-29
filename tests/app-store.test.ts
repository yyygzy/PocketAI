// app-store 标签保活/休眠逻辑测试
//
// store 在 import 时即通过 zustand persist 实例化（默认读 localStorage），
// vitest 为 node 环境：每个用例先 stub localStorage，再 vi.resetModules + 动态 import，
// 保证 store 状态与持久化内容完全隔离。
import { describe, it, expect, vi } from 'vitest'
import type { useAppStore as UseAppStore } from '../src/renderer/src/store/app-store'

type StoreState = ReturnType<typeof UseAppStore.getState>
type StoreModule = typeof import('../src/renderer/src/store/app-store')

async function loadStore(initialStorage?: Record<string, string>): Promise<{
  mod: StoreModule
  state: StoreState
}> {
  const map = new Map<string, string>(Object.entries(initialStorage ?? {}))
  const g = globalThis as unknown as { localStorage: Storage; window?: unknown }
  g.localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    }
  } as Storage
  // zustand persist 默认 storage factory 引用 window.localStorage；
  // node 测试环境无 window，缺失时中间件会整体短路（无 hydrate/api.persist）
  g.window = globalThis
  vi.resetModules()
  const mod = await import('../src/renderer/src/store/app-store')
  // persist hydrate 经 thenable 微任务链完成（merge → setState）
  await new Promise((r) => setTimeout(r, 0))
  return { mod, state: mod.useAppStore.getState() }
}

/** 模拟 App 的 effect：switchModule 后 touchModule（真实环境由 activeModule 变化驱动） */
function goto(state: StoreState, id: 'settings' | 'knowledge' | 'files' | 'notes'): void {
  state.switchModule(id, id)
  state.touchModule(id)
}

describe('app-store 纯函数', () => {
  it('evictMounted：未超阈值原样返回', async () => {
    const { mod } = await loadStore()
    expect(mod.evictMounted(['a', 'b'], { activeId: 'b', pinnedIds: [], busyIds: [], max: 4 })).toEqual(['a', 'b'])
  })

  it('evictMounted：超阈值淘汰 LRU 尾部，active 即使在尾部也豁免', async () => {
    const { mod } = await loadStore()
    // 头部最近访问；active 'e' 在最尾，扫描时跳过 e，先淘汰 d
    expect(mod.evictMounted(['a', 'b', 'c', 'd', 'e'], { activeId: 'e', pinnedIds: [], busyIds: [], max: 4 }))
      .toEqual(['a', 'b', 'c', 'e'])
  })

  it('evictMounted：pinned 与 busy 模块豁免，全部受保护时宁超阈值不淘汰', async () => {
    const { mod } = await loadStore()
    const mounted = ['a', 'b', 'c', 'd', 'e']
    // d pinned、e busy、a active → 只能淘汰 b/c；但只需淘汰 1 个：尾部扫描 e 跳、d 跳、c 淘汰
    expect(mod.evictMounted(mounted, { activeId: 'a', pinnedIds: ['d'], busyIds: ['e'], max: 4 }))
      .toEqual(['a', 'b', 'd', 'e'])
    // 全部受保护 → 长度 5 原样保留（不中断流式优先于内存上限）
    const allProtected = mod.evictMounted(
      ['a', 'b', 'c', 'd', 'e'],
      { activeId: 'a', pinnedIds: ['b', 'c'], busyIds: ['d', 'e'], max: 4 }
    )
    expect(allProtected).toHaveLength(5)
  })

  it('pinFirst：pinned 前置且保持组内相对顺序；无 pinned 原样返回', async () => {
    const { mod } = await loadStore()
    const tabs = [
      { id: '1', title: 'a', moduleId: 'chat' },
      { id: '2', title: 'b', moduleId: 'settings', pinned: true },
      { id: '3', title: 'c', moduleId: 'files' }
    ]
    expect(mod.pinFirst(tabs).map((tb) => tb.id)).toEqual(['2', '1', '3'])
    expect(mod.pinFirst([tabs[0]!, tabs[2]!]).map((tb) => tb.id)).toEqual(['1', '3'])
  })

  it('reconcileMounted：关闭标签后移除孤儿模块并保证活动模块在列', async () => {
    const { mod } = await loadStore()
    const tabs = [{ id: '1', title: 'chat', moduleId: 'chat' }]
    // settings 已无标签 → 卸载；chat 提到头部
    expect(mod.reconcileMounted(['settings', 'chat'], tabs, 'chat')).toEqual(['chat'])
  })
})

describe('app-store 保活 actions', () => {
  it('touchModule：新模块插入 LRU 头部，重复 touch 只移到头部', async () => {
    const { mod, state } = await loadStore()
    goto(state, 'settings')
    goto(state, 'knowledge')
    expect(mod.useAppStore.getState().mountedModules).toEqual(['knowledge', 'settings', 'chat'])

    state.touchModule('settings')
    expect(mod.useAppStore.getState().mountedModules).toEqual(['settings', 'knowledge', 'chat'])
  })

  it('touchModule：挂载数超 MAX_KEPT_MODULES 时淘汰最久未访问模块', async () => {
    const { mod, state } = await loadStore()
    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) {
      goto(state, id)
    }
    const mounted = mod.useAppStore.getState().mountedModules
    expect(mounted).toHaveLength(mod.MAX_KEPT_MODULES)
    expect(mounted).toEqual(['notes', 'files', 'knowledge', 'settings'])
    expect(mounted).not.toContain('chat')
  })

  it('pinned 标签对应模块豁免休眠；togglePin 切换固定并前置', async () => {
    const { mod, state } = await loadStore()
    // 固定初始 chat 标签
    const chatTabId = mod.useAppStore.getState().tabs[0]!.id
    state.togglePin(chatTabId)
    const pinned = mod.useAppStore.getState()
    expect(pinned.tabs[0]!.pinned).toBe(true)

    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) {
      goto(state, id)
    }
    const mounted = mod.useAppStore.getState().mountedModules
    // chat 虽最久未访问但 pinned 豁免；被淘汰的是 settings
    expect(mounted).toContain('chat')
    expect(mounted).not.toContain('settings')
    expect(mounted).toHaveLength(mod.MAX_KEPT_MODULES)

    // 取消固定：pinned 标志清除
    state.togglePin(chatTabId)
    expect(mod.useAppStore.getState().tabs.find((tb) => tb.id === chatTabId)!.pinned).toBeFalsy()
  })

  it('busy 模块豁免休眠；busy 解除后下一次更新补淘汰', async () => {
    const { mod, state } = await loadStore()
    // 让全部 5 个模块都处于保护态：chat busy + 依次切 4 个模块（各自 busy，最新者为 active）
    state.setModuleBusy('chat', true)
    for (const id of ['settings', 'knowledge', 'files', 'notes'] as const) {
      goto(state, id)
      state.setModuleBusy(id, true)
    }
    let mounted = mod.useAppStore.getState().mountedModules
    expect(mounted).toHaveLength(5) // 全部受保护，宁超阈值不淘汰
    expect(mounted).toContain('chat')

    // 解除 chat busy → setModuleBusy 内补淘汰，最久未访问且不再受保护的 chat 出局
    state.setModuleBusy('chat', false)
    mounted = mod.useAppStore.getState().mountedModules
    expect(mounted).toHaveLength(mod.MAX_KEPT_MODULES)
    expect(mounted).not.toContain('chat')
  })

  it('closeTab：关闭模块最后一个标签时同步卸载其保活实例并切回活动模块', async () => {
    const { mod, state } = await loadStore()
    goto(state, 'settings') // mounted: settings, chat
    expect(mod.useAppStore.getState().mountedModules).toContain('settings')

    const settingsTab = mod.useAppStore.getState().tabs.find((tb) => tb.moduleId === 'settings')!
    state.closeTab(settingsTab.id)
    const after = mod.useAppStore.getState()
    expect(after.mountedModules).toEqual(['chat'])
    expect(after.activeModule).toBe('chat')
  })
})

describe('app-store persist merge', () => {
  it('重启后恢复标签布局，mountedModules 仅挂载活动模块（保活态不持久化）', async () => {
    // zustand persist 存储格式：{ state: partialize 结果, version }
    const persisted = JSON.stringify({
      state: {
        tabs: [
          { moduleId: 'settings', title: '设置', pinned: true },
          { moduleId: 'chat', title: '新对话' }
        ],
        activeTabId: 1
      },
      version: 0
    })
    const { state } = await loadStore({ 'pocketai.tabs.v1': persisted })
    expect(state.tabs).toHaveLength(2)
    expect(state.activeModule).toBe('chat')
    expect(state.mountedModules).toEqual(['chat'])
    expect(state.busyModules).toEqual({})
    // pinned 标志随标签恢复
    expect(state.tabs.find((tb) => tb.moduleId === 'settings')!.pinned).toBe(true)
  })
})
