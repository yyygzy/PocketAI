// @vitest-environment jsdom
// V4-Iter-347：§345 那批"判过有牙、本批没接"的两处列表族收口——提醒中心那份清单、定价表那份模型清单。
//
// 缺陷形状与 §345 完全同一族：门只认「数据缺失」（`items === null ? …`／`models === null ? …`），
// 清单一旦到货，那一发再失败就没人说——屏上摆着一份**没人认领的旧清单**，行内的键照旧可点。
// 两处各自的重取入口不止一个读者：
//  · 提醒中心的 `reload(tab)` 除挂载外还有到点广播／本地变更事件／增删改后共六处 caller；
//  · 定价表那一发改前挂在 `deps=[onError]` 上、调用点传的是行内箭头⇒**父页每渲染一次就多读一发**
//    （§322 那一族）。这一处**不挂旧值横幅**：把逐渲染重读收干之后，`models` 在屏上时再没有第二个写者
//    能把 `modelsErr` 写起来（收起再展开是重新挂载、state 从零开始）⇒"停在上一份"这一档不会出现，
//    写横幅就是永不生效的守卫。§345 当时判它"有牙"靠的正是那条重读——**重读是缺陷，不是读者**。
//    P2 是这条判据的反向对照（重新展开确实会再发一发），P1 的"不多发"因此不是恒绿。
// 定价表真正补上的是**抛出面**：那一发 reject 时也写常驻那句（§251：两条到货的路都要有出口），由 P3 演。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  ReminderRecord,
  UsageAssistantItem,
  UsageConversationItem,
  UsageModelItem,
  UsagePricing,
  UsageSummary
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const STALE = (what: string, msg: string): string =>
  L('common.refreshFailedNamed').replace('{what}', what).replace('{msg}', msg)
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const FAIL = { ok: false, error: '库被占用' }

/** 同名通道的到货队列：一个槽会被后到的顶掉，迟到的那一发就演不出来（§330 那条踩过的坑） */
let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

// ─────────────────────────── 提醒中心那份清单 ───────────────────────────
const reminder = (id: string, text: string): ReminderRecord =>
  ({
    id, text, fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(), status: 'pending',
    conversationId: null, createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime()
  }) as unknown as ReminderRecord

const REMINDERS = [reminder('r1', '喝水'), reminder('r2', '交报告')]
const TITLE = L('reminder.center.title')

beforeEach(() => {
  q = {}
  localStorage.clear()
})

describe('提醒中心：清单已经在屏上、那一发又没读到时，原因必须有出口', () => {
  beforeEach(() => {
    stubPocketai({
      listReminders: (scope: string) => pend(`rem:${scope}`),
      onReminderFired: () => () => {}
    })
  })

  it('R1 正向对照：挂载那一发读到 ⇒ 清单在屏上、一个 alert 都不许有', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    await settle()
    answer('rem:pending', REMINDERS)
    await settle()
    expect(screen.getByText('喝水')).toBeTruthy()
    expect(alerts(), '成功的那一发不许被说成旧值').toEqual([])
  })

  it('R2 有值时重读失败（本地变更事件那一发）⇒ 旧值横幅上屏，两行照旧在', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', REMINDERS)
    await settle()
    expect(alerts()).toEqual([])

    await act(async () => {
      window.dispatchEvent(new Event('pocketai:reminders-changed'))
    })
    await waitFor(() => expect(callsOf('listReminders')).toBe(2))
    answer('rem:pending', FAIL)
    await waitFor(() => expect(alerts()).toEqual([STALE(TITLE, '库被占用')]))
    expect(screen.getByText('喝水')).toBeTruthy()
    expect(screen.getByText('交报告')).toBeTruthy()
  })

  it('R3 按重试真再发一发，成功后那句当场收回', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', REMINDERS)
    await settle()
    await act(async () => {
      window.dispatchEvent(new Event('pocketai:reminders-changed'))
    })
    await waitFor(() => expect(callsOf('listReminders')).toBe(2))
    answer('rem:pending', FAIL)
    await waitFor(() => expect(alerts()).toEqual([STALE(TITLE, '库被占用')]))

    fireEvent.click(screen.getByTestId('reminders-list-stale-retry'))
    await waitFor(() => expect(callsOf('listReminders')).toBe(3))
    answer('rem:pending', [reminder('r1', '喝水')])
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getByText('喝水')).toBeTruthy()
    expect(screen.queryByText('交报告'), '重试读回来的那份才作数').toBeNull()
  })

  it('R4 反向对照：一发都没读到＋失败 ⇒ 仍是 §222 那句「读不到」，不许被顶成"这是旧值"', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', FAIL)
    await waitFor(() => expect(alerts()).toEqual([FAILED('库被占用')]))
  })

  it('R5 抛出面（桥层抛出，不走 safeHandle 的信封）同一张脸：有值时挂旧值横幅', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', REMINDERS)
    await settle()
    stubPocketai({
      listReminders: () => Promise.reject(new Error('通道没接上')),
      onReminderFired: () => () => {}
    })
    await act(async () => {
      window.dispatchEvent(new Event('pocketai:reminders-changed'))
    })
    await waitFor(() => expect(callsOf('listReminders')).toBe(2), MOUNT_BUDGET)
    await waitFor(() => expect(alerts()).toEqual([STALE(TITLE, '通道没接上')]))
    expect(screen.getByText('喝水')).toBeTruthy()
  })

  it('R6 切 tab 时不许把上一个 tab 那句「读不到」挂到新一屏的加载中位上', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', FAIL)
    await waitFor(() => expect(alerts()).toEqual([FAILED('库被占用')]))

    // 切到「历史」：那一发还在飞——此刻屏上该是「加载中」，不是上一个 tab 的失败原因
    fireEvent.click(screen.getByRole('button', { name: L('reminder.center.tabHistory') }))
    await waitFor(() => expect(callsOf('listReminders')).toBe(2))
    expect(alerts(), '换 tab 后那句旧原因属于上一发请求').toEqual([])
    expect(screen.getByText(L('common.loading'))).toBeTruthy()
  })
})

// ─────────────────────────── 定价表那份模型清单 ───────────────────────────
const summary = (requests: number): UsageSummary => ({
  days: 30, totals: { requests, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost: 0 },
  daily: [], byProvider: [], byModel: []
}) as unknown as UsageSummary
const pricing = (): UsagePricing => ({ currency: 'CNY', prices: {} }) as unknown as UsagePricing
const models = (label: string): UsageModelItem[] =>
  [{ provider: '本地', model: label, lastUsedAt: Date.now() }] as unknown as UsageModelItem[]

const okReads = {
  getUsageSummary: () => summary(7),
  getUsageConversations: () => [] as UsageConversationItem[],
  getUsageAssistants: () => [] as UsageAssistantItem[],
  getUsagePricing: () => pricing(),
  getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
}

/** 导航到那一格：设置页 → 用量屏 → 展开「单价设置」，展开的那一刻才发这一发读 */
async function openPriceEditor(): Promise<void> {
  mountWithProviders(<UsagePanel />)
  await waitFor(() => expect(callsOf('getUsageSummary')).toBe(1))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
  await waitFor(() => expect(callsOf('listUsageModels')).toBe(1), MOUNT_BUDGET)
  await settle()
}

describe('定价表的模型清单：逐渲染重读收干＋两条到货的路都有出口（这一处不挂旧值横幅，理由见闸门头部）', () => {
  beforeEach(() => {
    stubPocketai({
      ...okReads,
      listUsageModels: () => pend('models')
    })
  })

  it('P1 父页重渲染不许再多发一发（改前 `deps=[行内箭头]`⇒每次渲染重读，§322 同族）', async () => {
    await openPriceEditor()
    answer('models', models('glm-4.6'))
    await settle()
    expect(callsOf('listUsageModels'), '展开那一格只该发一发').toBe(1)

    // 切一次时间窗＝UsagePanel 重渲染一次；改前那一发读会跟着重跑
    fireEvent.click(screen.getByRole('button', { name: L('usage.days90') }))
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(2))
    await settle()
    expect(callsOf('listUsageModels'), '父页重渲染又发来一发').toBe(1)
    expect(screen.getByText('glm-4.6')).toBeTruthy()
  })

  it('P2 正向对照：这一格确实重挂载就重读（P1 那条"不多发"不是恒绿的）', async () => {
    await openPriceEditor()
    answer('models', models('glm-4.6'))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
    await waitFor(() => expect(callsOf('listUsageModels')).toBe(2), MOUNT_BUDGET)
    answer('models', models('qwen3'))
    await settle()
    expect(screen.getByText('qwen3')).toBeTruthy()
    expect(screen.queryByText('glm-4.6'), '重新展开读回来的那份才作数').toBeNull()
  })

  it('P3 那一发抛出（桥层 reject）⇒ 常驻那句「读不到」上屏，不再只留一条会消失的 toast', async () => {
    stubPocketai({ ...okReads, listUsageModels: () => Promise.reject(new Error('通道没接上')) })
    mountWithProviders(<UsagePanel />)
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(1))
    await settle()
    // 展开「单价设置」才是这一发读的挂载时机
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
    await waitFor(() => expect(callsOf('listUsageModels')).toBe(1), MOUNT_BUDGET)
    await waitFor(() => expect(alerts()).toEqual([FAILED('通道没接上')]), MOUNT_BUDGET)
  })

  it('P4 信封失败（resolve 面）同一张脸：那句常驻的原因在，表格里不许拿失败对象当清单', async () => {
    await openPriceEditor()
    answer('models', FAIL)
    await waitFor(() => expect(alerts()).toEqual([FAILED('库被占用')]))
    expect(alerts().join(''), '一发都没读到⇒不许被说成"停在上一份"').not.toContain('停在上一份')
    // 这一处没有旧值横幅：那一发只有这一个读者（闸门头部记着这条更正）⇒屏上也不许冒出那颗键
    expect(screen.queryByTestId('usage-models-stale-retry'), '定价表这颗键是上一稿留下的，本批判为无落点').toBeNull()
  })
})
