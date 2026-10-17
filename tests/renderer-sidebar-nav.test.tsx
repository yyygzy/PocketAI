// 侧栏作为唯一导航：右键弹出独立窗口 / 固定不被休眠（V4-Iter-112）
//
// 标签栏下线后，它独占的两个动作搬到侧栏模块项的右键菜单上。这里钉的是：
// ① 顺序与可见序号角标来自 store（Ctrl+1..9 按同一份顺序绑定）；
// ② 只有 DETACHABLE_MODULE_IDS 里的模块出现「在独立窗口打开」；
// ③ 固定要落库，落库失败必须回滚——不能停在"看着固定了其实没存"。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { stubPocketai, pocketaiCalls, mountWithProviders } from './helpers/renderer'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { useAppStore } from '../src/renderer/src/store/app-store'
import { DEFAULT_SIDEBAR_ORDER, MAX_PINNED_SIDEBAR_MODULES } from '../src/shared/types'
import { zh } from '../src/renderer/src/i18n/zh'

interface Opts {
  order?: string[]
  pinned?: string[]
  /** 保存固定列表的返回（默认成功并回显） */
  setPinnedResult?: (list: string[]) => { ok: boolean; data?: string[]; error?: string }
  /** 保存顺序的返回（默认成功并回显）；给 {ok:false} 就能验回滚 */
  setOrderResult?: (list: string[]) => { ok: boolean; data?: string[]; error?: string }
  /** getSidebarOrder 的返回（默认与 order 一致；回滚场景要给它「库里那份」） */
  getOrderResult?: (list: string[]) => { ok: boolean; data?: string[] }
}

function mount(opts: Opts = {}) {
  const order = (opts.order ?? DEFAULT_SIDEBAR_ORDER) as typeof DEFAULT_SIDEBAR_ORDER
  const pinned = opts.pinned ?? []
  stubPocketai({
    listReminders: () => [],
    onReminderFired: () => () => {},
    getSidebarPinned: () => ({ ok: true, data: pinned }),
    setSidebarPinned: (list: string[]) =>
      opts.setPinnedResult ? opts.setPinnedResult(list) : { ok: true, data: list },
    setSidebarOrder: (list: string[]) =>
      opts.setOrderResult ? opts.setOrderResult(list) : { ok: true, data: list },
    getSidebarOrder: () =>
      opts.getOrderResult ? opts.getOrderResult(order) : { ok: true, data: order },
    openDetachedWindow: () => ({ ok: true })
  })
  return mountWithProviders(
    <Sidebar active="chat" onChange={() => {}} collapsed={false} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
  )
}

/** 打开某个模块项的右键菜单 */
function openMenuOf(label: string): void {
  fireEvent.contextMenu(screen.getByLabelText(label))
}

function ipcArgsOf(fn: string): unknown[][] {
  return pocketaiCalls().filter((c) => c.fn === fn).map((c) => c.args)
}

beforeEach(() => {
  useAppStore.setState({
    activeModule: 'chat',
    mountedModules: ['chat'],
    busyModules: {},
    pinnedModules: [],
    sidebarOrder: [...DEFAULT_SIDEBAR_ORDER]
  })
})

describe('侧栏模块列表', () => {
  it('按 store 的顺序渲染全部模块，前 9 项带 Ctrl+序号角标', async () => {
    mount()
    await screen.findByLabelText('知识库')
    expect(screen.getByText('⌃1')).toBeTruthy()
    expect(screen.getByText('⌃9')).toBeTruthy()
    expect(screen.queryByText('⌃10')).toBeNull()
  })

  it('反向对照：库里存了自定义顺序时，第一项就是它（快捷键 ⌃1 与界面一致）', async () => {
    const custom = ['settings', ...DEFAULT_SIDEBAR_ORDER.filter((m) => m !== 'settings')]
    mount({ order: custom })
    await screen.findByLabelText(zh['sidebar.settings'])
    const items = screen.getAllByRole('button').filter((el) => el.textContent?.includes('⌃'))
    expect(items[0]?.textContent).toContain(zh['sidebar.settings'])
  })
})

describe('右键菜单：弹出独立窗口', () => {
  it('可弹出的模块出现该项，点击后按模块 id 开独立窗', async () => {
    mount()
    await screen.findByLabelText('知识库')
    openMenuOf('知识库')
    fireEvent.click(screen.getByText(zh['sidebar.popOut']))
    expect(ipcArgsOf('openDetachedWindow')).toEqual([['knowledge']])
  })

  it('设置/终端/平台管家不可弹出（菜单里没有该动作，也不报错）', async () => {
    mount()
    await screen.findByLabelText('设置')
    openMenuOf('设置')
    expect(screen.queryByText(zh['sidebar.popOut'])).toBeNull()
    // 固定动作仍在
    expect(screen.getByText(zh['sidebar.pin'])).toBeTruthy()
  })
})

describe('右键菜单：固定不被休眠', () => {
  it('点固定 → 进 store（出现 📌）并落库', async () => {
    mount()
    await screen.findByLabelText('知识库')
    openMenuOf('知识库')
    fireEvent.click(screen.getByText(zh['sidebar.pin']))
    expect(ipcArgsOf('setSidebarPinned')).toEqual([[['knowledge']]])
    expect(useAppStore.getState().pinnedModules).toEqual(['knowledge'])
    expect(screen.getByText('📌')).toBeTruthy()
  })

  it('已固定的项菜单里是「取消固定」，点它清空并落库', async () => {
    mount({ pinned: ['knowledge'] })
    await screen.findByLabelText('知识库')
    openMenuOf('知识库')
    fireEvent.click(screen.getByText(zh['sidebar.unpin']))
    expect(ipcArgsOf('setSidebarPinned')).toEqual([[[]]])
    expect(useAppStore.getState().pinnedModules).toEqual([])
  })

  it('固定数达上限时第 5 个不可点（不静默丢弃用户的动作）', async () => {
    const full = DEFAULT_SIDEBAR_ORDER.slice(0, MAX_PINNED_SIDEBAR_MODULES)
    mount({ pinned: [...full] })
    await screen.findByLabelText('设置')
    openMenuOf('设置')
    const btn = screen.getByText(zh['sidebar.pin']) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(ipcArgsOf('setSidebarPinned')).toEqual([])
  })

  it('落库失败 → 回滚读库，界面不停在"已固定"', async () => {
    mount({ setPinnedResult: () => ({ ok: false, error: '存不下' }) })
    await screen.findByLabelText('知识库')
    openMenuOf('知识库')
    fireEvent.click(screen.getByText(zh['sidebar.pin']))
    // 回滚会再读一次库（库里始终是空的）
    await screen.findByLabelText('知识库')
    expect(ipcArgsOf('getSidebarPinned').length).toBeGreaterThan(1)
    expect(useAppStore.getState().pinnedModules).toEqual([])
    expect(screen.queryByText('📌')).toBeNull()
  })
})
// —— V4-Iter-172：B53 对账现查的那条零覆盖 ——
// 侧栏的拖拽排序此前只有 store/schema 层被钉过，**真实的 drop 处理没人动过**；
// 而 V4-Iter-112 的教训正是"schema 漏一项 ⇒ 拖拽从上线起就坏了没人发现"。
// 这里从 DOM 上真拖一次：钉"移动生效 + 落库载荷是改后那份 + 落库失败必须回滚"。
describe('侧栏真拖拽排序（V4-Iter-172 补）', () => {
  const dt = (): Record<string, unknown> => ({
    setData: () => {}, getData: () => '', clearData: () => {}, setDragImage: () => {},
    effectAllowed: '', dropEffect: '', types: []
  })
  const orderOf = (): string[] => useAppStore.getState().sidebarOrder

  function dragTo(fromLabel: string, toLabel: string): void {
    const from = screen.getByLabelText(fromLabel)
    const to = screen.getByLabelText(toLabel)
    fireEvent.dragStart(from, { dataTransfer: dt() })
    fireEvent.dragOver(to, { dataTransfer: dt() })
    fireEvent.drop(to)
    fireEvent.dragEnd(from)
  }

  it('把「知识库」拖到「对话」前面 ⇒ 界面顺序立刻变，且落库发的是改后那份', async () => {
    const saved: string[][] = []
    stubPocketai({
      listReminders: () => [],
      onReminderFired: () => () => {},
      getSidebarOrder: () => ({ ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }),
      getSidebarPinned: () => ({ ok: true, data: [] }),
      setSidebarPinned: (l: string[]) => ({ ok: true, data: l }),
      setSidebarOrder: (l: string[]) => {
        saved.push(l as string[])
        return { ok: true, data: l }
      },
      openDetachedWindow: () => ({ ok: true })
    })
    mountWithProviders(
      <Sidebar active="chat" onChange={() => {}} collapsed={false} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
    )
    await screen.findByLabelText('知识库')
    const before = orderOf()
    expect(before[0]).toBe('chat')
    dragTo('知识库', '对话')
    const after = orderOf()
    expect(after.slice(0, 2)).toEqual(['knowledge', 'chat'])
    await waitFor(() => expect(saved.length).toBeGreaterThan(0))
    expect(saved[saved.length - 1]).toEqual(after)
    // 只是换位，不许丢项或造出重复
    expect([...after].sort()).toEqual([...before].sort())
  })

  it('落库失败 ⇒ 回滚到库里那份，界面不停在"看着排好了其实没存"', async () => {
    stubPocketai({
      listReminders: () => [],
      onReminderFired: () => () => {},
      getSidebarOrder: () => ({ ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }),
      getSidebarPinned: () => ({ ok: true, data: [] }),
      setSidebarPinned: (l: string[]) => ({ ok: true, data: l }),
      setSidebarOrder: () => ({ ok: false, error: '保存失败' }),
      openDetachedWindow: () => ({ ok: true })
    })
    mountWithProviders(
      <Sidebar active="chat" onChange={() => {}} collapsed={false} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
    )
    await screen.findByLabelText('知识库')
    dragTo('知识库', '对话')
    expect(orderOf()).toEqual(['knowledge', 'chat', ...DEFAULT_SIDEBAR_ORDER.filter((x) => x !== 'knowledge' && x !== 'chat')])
    await waitFor(() => expect(orderOf()).toEqual([...DEFAULT_SIDEBAR_ORDER]), { timeout: 2000 })
  })

  it('反向对照：只按下不落到别的项上（dragEnd 前没 drop）⇒ 一次都不写库', async () => {
    const callsBefore = pocketaiCalls().filter((c) => c.fn === 'setSidebarOrder').length
    stubPocketai({
      listReminders: () => [],
      onReminderFired: () => () => {},
      getSidebarOrder: () => ({ ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }),
      getSidebarPinned: () => ({ ok: true, data: [] }),
      setSidebarPinned: (l: string[]) => ({ ok: true, data: l }),
      setSidebarOrder: (l: string[]) => ({ ok: true, data: l }),
      openDetachedWindow: () => ({ ok: true })
    })
    mountWithProviders(
      <Sidebar active="chat" onChange={() => {}} collapsed={false} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
    )
    await screen.findByLabelText('知识库')
    fireEvent.dragStart(screen.getByLabelText('知识库'), { dataTransfer: dt() })
    fireEvent.dragEnd(screen.getByLabelText('知识库'))
    expect(orderOf()).toEqual([...DEFAULT_SIDEBAR_ORDER])
    expect(pocketaiCalls().filter((c) => c.fn === 'setSidebarOrder').length).toBe(callsBefore)
  })
})
