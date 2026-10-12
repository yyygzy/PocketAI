// 侧栏作为唯一导航：右键弹出独立窗口 / 固定不被休眠（V4-Iter-112）
//
// 标签栏下线后，它独占的两个动作搬到侧栏模块项的右键菜单上。这里钉的是：
// ① 顺序与可见序号角标来自 store（Ctrl+1..9 按同一份顺序绑定）；
// ② 只有 DETACHABLE_MODULE_IDS 里的模块出现「在独立窗口打开」；
// ③ 固定要落库，落库失败必须回滚——不能停在"看着固定了其实没存"。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import React from 'react'
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
}

function mount(opts: Opts = {}) {
  const order = (opts.order ?? DEFAULT_SIDEBAR_ORDER) as typeof DEFAULT_SIDEBAR_ORDER
  const pinned = opts.pinned ?? []
  stubPocketai({
    listReminders: () => [],
    onReminderFired: () => () => {},
    getSidebarOrder: () => ({ ok: true, data: order }),
    getSidebarPinned: () => ({ ok: true, data: pinned }),
    setSidebarPinned: (list: string[]) =>
      opts.setPinnedResult ? opts.setPinnedResult(list) : { ok: true, data: list },
    setSidebarOrder: (list: string[]) => ({ ok: true, data: list }),
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
