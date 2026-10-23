// V4-Iter-275：侧栏两发（顺序／固定模块）与浮窗一发（payload）的读取失败不再静默。
//
// 起因是闸门第四面量到的 17 处里这三格：Sidebar.tsx 用 Promise.all 把两发绑在一起，
// 一发失败两发都丢；PopupApp.tsx 的 getPopupPayload 失败时只进 console，界面停在初值。
// 改法是拆开独立判、失败侧挂原因、成功即收回；Sidebar 配两颗重试键（顺序／固定各一颗），
// PopupApp 配 LoadFailNotice（整块没内容那一档）。
//
// 五条用例是一套的：两发失败各说一句＋各给一键（Sidebar）、一发失败说一句（PopupApp）、
// 重试键点了有效（Sidebar）、成功读回时通知收回（反向对照）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { stubPocketai, mountWithProviders } from './helpers/renderer'
import { Sidebar } from '../src/renderer/src/components/Sidebar'
import { useAppStore } from '../src/renderer/src/store/app-store'
import { DEFAULT_SIDEBAR_ORDER } from '../src/shared/types'
import { zh } from '../src/renderer/src/i18n/zh'

function mountSidebar(opts: {
  getOrder?: () => unknown
  getPinned?: () => unknown
}): void {
  const { getOrder = () => ({ ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }), getPinned = () => ({ ok: true, data: [] }) } = opts
  stubPocketai({
    listReminders: () => [],
    onReminderFired: () => () => {},
    getSidebarOrder: getOrder,
    getSidebarPinned: getPinned,
    setSidebarOrder: (list: string[]) => ({ ok: true, data: list }),
    setSidebarPinned: (list: string[]) => ({ ok: true, data: list }),
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

describe('侧栏两发读取失败的三张脸', () => {
  it('顺序那一读失败 ⇒ 摆「读不到侧栏顺序」＋重试键', async () => {
    mountSidebar({ getOrder: () => ({ ok: false, error: 'DB_LOCKED:库被占着' }) })
    await waitFor(() => expect(screen.getByText(/侧栏顺序读不到/)).toBeTruthy())
    expect(screen.getByText(zh['agent.retryRead'])).toBeTruthy()
    // 反向对照：固定那一读没失败 ⇒ 不该摆它的通知
    expect(screen.queryByText(/固定模块读不到/)).toBeNull()
  })

  it('固定那一读失败 ⇒ 摆「读不到固定模块」＋重试键', async () => {
    mountSidebar({ getPinned: () => ({ ok: false, error: 'DB_LOCKED:库被占着' }) })
    await waitFor(() => expect(screen.getByText(/固定模块读不到/)).toBeTruthy())
    expect(screen.getByText(zh['agent.retryRead'])).toBeTruthy()
    // 反向对照：顺序那一读没失败 ⇒ 不该摆它的通知
    expect(screen.queryByText(/侧栏顺序读不到/)).toBeNull()
  })

  it('两发都失败 ⇒ 两句都摆出来、两颗键都摆出来', async () => {
    mountSidebar({
      getOrder: () => ({ ok: false, error: 'ERR_ORDER' }),
      getPinned: () => ({ ok: false, error: 'ERR_PINNED' })
    })
    await waitFor(() => {
      expect(screen.getByText(/侧栏顺序读不到/)).toBeTruthy()
      expect(screen.getByText(/固定模块读不到/)).toBeTruthy()
    })
    const buttons = screen.getAllByText(zh['agent.retryRead'])
    expect(buttons.length).toBe(2)
  })

  it('侧栏折起来 ⇒ 通知不摆（窄屏不让它挤占）', async () => {
    stubPocketai({
      listReminders: () => [],
      onReminderFired: () => () => {},
      getSidebarOrder: () => ({ ok: false, error: 'ERR' }),
      getSidebarPinned: () => ({ ok: false, error: 'ERR' }),
      setSidebarOrder: (list: string[]) => ({ ok: true, data: list }),
      setSidebarPinned: (list: string[]) => ({ ok: true, data: list }),
      openDetachedWindow: () => ({ ok: true })
    })
    mountWithProviders(
      <Sidebar active="chat" onChange={() => {}} collapsed={true} onToggleCollapse={() => {}} onOpenReminders={() => {}} />
    )
    await waitFor(() => expect(screen.getByLabelText('知识库')).toBeTruthy())
    expect(screen.queryByText(/侧栏顺序读不到/)).toBeNull()
    expect(screen.queryByText(/固定模块读不到/)).toBeNull()
  })

  it('重试键点了 ⇒ 重读一次，成功则通知收回', async () => {
    let callCount = 0
    mountSidebar({
      getOrder: () => {
        callCount++
        if (callCount === 1) return { ok: false, error: 'ERR_FIRST' }
        return { ok: true, data: [...DEFAULT_SIDEBAR_ORDER] }
      }
    })
    await waitFor(() => expect(screen.getByText(/侧栏顺序读不到/)).toBeTruthy())
    const retryBtn = screen.getByTestId('sidebar-order-retry')
    fireEvent.click(retryBtn)
    await waitFor(() => expect(screen.queryByText(/侧栏顺序读不到/)).toBeNull())
    expect(callCount).toBe(2)
  })
})
