// V4-Iter-250：提醒角标那一读——「读不到」不能长成「没有待发提醒」的样子。
//
// 起因是闸门第四面量到的 84 处里最典型的一格：`Sidebar.tsx` 用
// `.then((list) => { if (!hasIpcFailed(list)) setPendingReminders(list.length) })`，而 `safeHandle` 的失败是
// **resolve 的 `{ok:false}`**（§196），后面 `.catch(reportIpcError(...))` 接不到它 ⇒ 失败时角标停在初始值 `0`，
// 界面把"这次没读到"演成"确实没有提醒"。改法是把状态做成三态：数字 / 0 / `null`（读不到），`null` 时角标显示 `?`。
//
// 三条用例是一套的：**0 条与读不到必须算出不同的数**（只留一条就成了空断言，见 §推广二那条纪律）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { stubPocketai, mountWithProviders } from './helpers/renderer'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { useAppStore } from '../src/renderer/src/store/app-store'
import { DEFAULT_SIDEBAR_ORDER } from '../src/shared/types'
import { zh } from '../src/renderer/src/i18n/zh'

function mount(listReminders: () => unknown): void {
  stubPocketai({
    listReminders,
    onReminderFired: () => () => {},
    getSidebarPinned: () => ({ ok: true, data: [] }),
    setSidebarPinned: (list: string[]) => ({ ok: true, data: list }),
    setSidebarOrder: (list: string[]) => ({ ok: true, data: list }),
    getSidebarOrder: () => ({ ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }),
    openDetachedWindow: () => ({ ok: true })
  })
  mountWithProviders(
    <Sidebar active="chat" onChange={() => {}} collapsed={false} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
  )
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

describe('侧栏提醒角标的三张脸', () => {
  it('读到 3 条 ⇒ 角标就是 3', async () => {
    mount(() => [{ id: '1' }, { id: '2' }, { id: '3' }])
    await screen.findByText('3')
    expect(screen.queryByText('?')).toBeNull()
  })

  it('读到 0 条 ⇒ 角标不出现（这才叫"确实没有"）', async () => {
    mount(() => [])
    await screen.findByLabelText('知识库')
    expect(screen.queryByText('?')).toBeNull()
    expect(screen.queryByText('0')).toBeNull()
  })

  it('读不到 ⇒ 角标是 ?，并且把原因挂在 title 上（不停在 0）', async () => {
    mount(() => ({ ok: false, error: 'DB_LOCKED:库被占着' }))
    await waitFor(() => expect(screen.getByText('?')).toBeTruthy())
    expect(screen.getByText('?').getAttribute('title')).toBe(zh['reminder.center.pendingUnread'])
    // 反向对照：这条不是"读不到被演成没有"——`?` 与"没有角标"是两个可分辨的屏
    expect(screen.queryByText('0')).toBeNull()
  })
})
