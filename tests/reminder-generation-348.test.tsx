// @vitest-environment jsdom
// V4-Iter-348：提醒中心**同一块屏**上的并发两发——只有最后发出的那一发能写回
//
// §311 给这一屏立的判据是"跨 tab"那一轴（`tabRef.current !== scope`）。本批补的是第二轴：
// 同一块屏上 `reload(tab)` 会被好几个来源前后发出——到点广播、`pocketai:reminders-changed`、
// 取消／改期／删除后的重取、§345 那颗「重试」键。先发出的那一发可能后落地，于是把一份
// "取消前"的清单画回来：那一行照旧摆着、那颗「取消」照旧可点，再点一次就得到 §332 记过的那句谎
// （已经取消成功却弹"取消失败（提醒可能已触发）"）。
//
// ① 是正向对照（守卫不是恒关）；⑤ 盯"重渲染不多发"；④ 把 §311 那一轴在新形状下重验一遍
// （跨 tab 的迟到仍丢，且不许把新 tab 卡成「加载中…」——这是派发前那道 tab 判据的存在理由）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, HookProviders } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ReminderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

let resolvers: Array<(v: unknown) => void>
let firedCbs: Array<(e: unknown) => void>
const off = vi.fn()

const reminder = (id: string, text: string): ReminderRecord =>
  ({
    id, text, fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(), status: 'pending',
    conversationId: null, createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime()
  }) as unknown as ReminderRecord

const A = reminder('r-a', '喝水')
const B = reminder('r-b', '交报告')

/** 把第 n 发放出去并让 React 处理完这一轮（`.then` 之后还要一层 dispatch，故带 setTimeout） */
async function settle(n: number, value: unknown): Promise<void> {
  await act(async () => {
    resolvers[n]!(value)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const fireBroadcast = async (): Promise<void> => {
  await act(async () => {
    firedCbs.forEach((cb) => cb({ id: 'r-b' }))
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  resolvers = []
  firedCbs = []
  stubPocketai({
    // 每发都挂在 Promise 上，由用例决定谁先落地——乱序是这条缺陷的唯一入口
    listReminders: () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      }),
    // 订阅桩要记下**全部**回调：切 tab 时 effect 会重订一次，只留最后一个就把 §311 那一轴演没了
    onReminderFired: (cb: (e: unknown) => void) => {
      firedCbs.push(cb)
      return off
    },
    cancelReminder: () => ({ ok: true }),
    rescheduleNextReminder: () => ({ ok: true }),
    updateReminder: () => ({ ok: true })
  })
})

describe('提醒中心的代次守卫（同一块屏、并发两发）', () => {
  it('① 正向对照：两发按序落地 ⇒ 两份清单都写回（守卫不是恒关）', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    await settle(0, [A])
    expect(screen.getByText('喝水')).toBeTruthy()

    await fireBroadcast()
    expect(resolvers.length, '广播到达必须再发一发').toBe(2)
    await settle(1, [A, B])
    await waitFor(() => expect(screen.getByText('交报告')).toBeTruthy())
  })

  it('② 迟到对照：广播那发先落地、挂载那发迟到了 ⇒ 迟的那份旧清单不许画回来', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    await fireBroadcast()
    expect(resolvers.length).toBe(2)

    // 后发的第二发先落地：这份是"取消之后"的清单（只剩喝水）
    await settle(1, [A])
    expect(screen.getByText('喝水')).toBeTruthy()
    expect(screen.queryByText('交报告')).toBeNull()

    // 第一发（取消前的旧清单，两条都在）现在才回来
    await settle(0, [A, B])
    expect(screen.queryByText('交报告'), '迟到的旧读数顶掉新读数＝已取消那条被画回来，那颗「取消」键又亮了').toBeNull()
    expect(screen.getByText('喝水')).toBeTruthy()
  })

  it('③ 抛出面迟到也一样丢掉：已成功的新清单不许被说成"停在上一份"', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    await fireBroadcast()
    expect(resolvers.length).toBe(2)

    await settle(1, [A])
    expect(screen.queryAllByRole('alert')).toHaveLength(0)

    // 迟到的那一发这次是 reject（桥层抛出）
    await act(async () => {
      resolvers[0]!(Promise.reject(new Error('通道没接上')))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryAllByRole('alert'), '迟到的失败面不许盖在已刷新的清单上').toHaveLength(0)
    expect(screen.getByText('喝水')).toBeTruthy()
  })

  it('④ 跨 tab 那一轴照旧：切走的那发迟到不许写回，也不许把新 tab 卡在「加载中」', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    fireEvent.click(screen.getByText(L('reminder.center.tabHistory')))
    await waitFor(() => expect(resolvers.length).toBe(2), MOUNT_BUDGET)

    // 新 tab 那一发先落地
    await settle(1, [reminder('h1', '历史那条')])
    expect(screen.getByText('历史那条')).toBeTruthy()

    // 旧 tab 那发迟到
    await settle(0, [A])
    expect(screen.queryByText('喝水'), '待发那份不许画进历史 tab').toBeNull()
    expect(screen.getByText('历史那条'), '而历史那份也不许被顺手清掉（屏上不能退回"加载中…"）').toBeTruthy()
  })

  it('⑤ 重渲染不多发：一发读只挂一次订阅、一次派发', async () => {
    const { rerender } = mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(resolvers.length).toBe(1))
    await settle(0, [A])
    // 重渲染要连提供者一起给（裸 rerender 会把 ToastProvider 那层丢掉，当场抛 useToast）
    rerender(<HookProviders><RemindersModal onClose={() => {}} /></HookProviders>)
    rerender(<HookProviders><RemindersModal onClose={() => {}} /></HookProviders>)
    expect(resolvers.length, '每次 render 多读一发＝§322 那一族').toBe(1)
    expect(firedCbs.length, '订阅跟着重渲染重挂＝同一次挂载里多出一份读者').toBe(1)
    expect(screen.getByText('喝水')).toBeTruthy()
  })
})
