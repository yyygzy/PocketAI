// @vitest-environment jsdom
// V4-Iter-350：「读不到」那张脸（一发都没读到过）必须有用户命令得动的出口。
//
// 起点＝§349 真机：把 scratch 库的 `reminders` 表改名让主进程真回 `no such table`，
// 于是那一屏常驻那句「读不到」；**表改回来了，屏幕却一个字都不变**——因为 §347 那颗重试键长在
// "已经有旧值"那一支，而这一支（`items === null`）同屏没有任何东西会再发那一发。
// 事件面（到点广播／`pocketai:reminders-changed`）能重读，但那些都不是用户在这屏上按得动的键。
//
// 三处各演三条：①那一支确实同时有那句与那颗键（且键在 `role="alert"` 盒子**外面**，§268 的口径）；
// ②按下去真的再发一发（不是恒绿的装饰）；③到货后那句当场收回、脸整块换成本体。
// 反向对照两处：还在加载那一支不许有键（键不是常驻物）；首读失败那一屏 §347 那颗 stale 键必须不存在
// （两扇互斥——否则就是"停在上一份"和"一发都没读到"同时说）。
// 其余三处（MCP 清单／知识库两处清单）本轮只有闸门 `load-fail-read-retry-gate-350.test.ts` 看得见，
// 理由与 §345 同口径：那两块要现挂整块面板，夹具代价远大于这三处，账写在闸门头部与台账里。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  DataHealthReport,
  ReminderRecord,
  UsageAssistantItem,
  UsageConversationItem,
  UsagePricing,
  UsageSummary
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const FAIL = { ok: false, error: '库被占用' }
const RETRY = L('agent.retryRead')

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

// 同名通道的到货队列（§330 的口径：单槽会被后到的顶掉）
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

const reminder = (id: string, text: string): ReminderRecord =>
  ({
    id, text, fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(), status: 'pending',
    conversationId: null, createdAt: Date.now()
  }) as ReminderRecord
const REMINDERS = [reminder('r1', '买牛奶')]

describe('提醒中心：首读就失败 ⇒ 那句旁边就得有一颗能再发一发的键', () => {
  beforeEach(() => {
    q = {}
    stubPocketai({
      listReminders: (scope: string) => pend(`rem:${scope}`),
      onReminderFired: () => () => {}
    })
  })

  it('①②③ 失败脸有键、按下去真再发一发、到货后那句收回且行上屏', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    answer('rem:pending', FAIL)
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    // 键在同屏、且不在那条 alert 里（盒子内含按钮 ⇒ textContent 会把键名一起念进去，§268）
    const key = screen.getByTestId('reminders-list-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)
    // 这一屏不许同时挂 §347 那颗"停在上一份"的键（两扇互斥）
    expect(screen.queryByTestId('reminders-list-stale-retry')).toBeNull()

    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listReminders')).toBe(2))
    answer('rem:pending', REMINDERS)
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('reminders-list-read-retry')).toBeNull()
    expect(screen.getByText('买牛奶')).toBeTruthy()
  })

  it('反向对照：还在加载那一支没有那颗键（键不是一张常驻的脸）', async () => {
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await waitFor(() => expect(callsOf('listReminders')).toBe(1))
    // 那一发还没回来：屏上是「加载中…」，既没有原因也没有键
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('reminders-list-read-retry')).toBeNull()
    answer('rem:pending', REMINDERS)
    await settle()
  })
})

describe('数据健康：首读就失败 ⇒ 那颗长在报告里的「刷新」不在屏上，这一支得自带出口', () => {
  const report = (): DataHealthReport =>
    ({
      sizes: {
        userDataBytes: 1024, dbBytes: 1024, attachmentsBytes: 1024, extensionsBytes: 1024, logsBytes: 1024,
        otherBytes: 0, browserCacheBytes: 0, browserCacheFiles: 0
      },
      traces: { rows: 0, maxRowsInOneConversation: 0 },
      kb: {
        total: 0,
        byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 },
        errorDocs: [],
        integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
        vectorIndex: { count: 0, dims: [] }
      },
      backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
      tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
      boot: { stages: [], totalMs: 0 },
      recentPerf: [],
      perfHistory: []
    }) as unknown as DataHealthReport

  it('失败脸有键 ⇒ 按下去真再发一发（走的是本体那颗的同一个入口 load(true)）⇒ 报告上屏、那句收回', async () => {
    stubPocketai({ getDataHealth: () => FAIL })
    mountWithProviders(<DataHealthPanel />)
    await waitFor(() => expect(callsOf('getDataHealth')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('data-health-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    // 报告本体那颗「刷新」此刻根本不在屏上（这正是这一支原来没出口的原因）
    expect(screen.queryByRole('button', { name: L('dh.refresh') })).toBeNull()

    stubPocketai({ getDataHealth: () => report() })
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getDataHealth')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('data-health-read-retry')).toBeNull()
    expect(screen.getByText(L('dh.db'))).toBeTruthy()
  })
})

describe('用量汇总：首读就失败 ⇒ 那颗 `usage-summary-stale-retry` 不在屏上，这一支补自己的键', () => {
  const summary = (requests: number): UsageSummary =>
    ({
      days: 30, totals: { requests, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost: 0 },
      daily: [], byProvider: [], byModel: []
    }) as unknown as UsageSummary
  const okReads = {
    getUsageConversations: () => [] as UsageConversationItem[],
    getUsageAssistants: () => [] as UsageAssistantItem[],
    getUsagePricing: () => ({ currency: 'CNY', prices: {} }) as unknown as UsagePricing,
    getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
  }

  it('失败脸有键、按下去真再发一发、到货后那句收回且数字上屏；切日窗不会让它多发', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => FAIL })
    mountWithProviders(<UsagePanel />)
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('usage-summary-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    expect(screen.queryByTestId('usage-summary-stale-retry')).toBeNull()

    // 切窗改的是 days ⇒ effect 会重读：这颗键守的是"按下去多发一发"，不是"只有它能多发"
    fireEvent.click(screen.getByRole('button', { name: L('usage.days7') }))
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(2))
    await settle()

    stubPocketai({ ...okReads, getUsageSummary: () => summary(9) })
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(3))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('usage-summary-read-retry')).toBeNull()
    expect(screen.getByText('9')).toBeTruthy()
  })
})
