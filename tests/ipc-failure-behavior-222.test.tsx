// @vitest-environment jsdom
// V4-Iter-222：「读不到」与「还在加载」分成两个界面态。
//
// §221 把"失败对象被当数据写进 state"那一族收口后，读失败的面板改成"保持上一次的值"——
// 首次挂载没有上一次的值，于是本体长期停在 `if (!x) return 加载中…`：**把"这次没读到"谎称成"还在加载"**。
// 这一批给这一格一个真的界面事实（`LoadFailNotice`，role=alert，原因常驻），并演四块面板：
// 数据健康、用量汇总、单价表格里那一格、Ollama 运行时状态。
//
// 每块都配反向对照，两半各钉一件事：
//   ① 失败 ⇒ 出现「读不到：原因」且**「加载中…」必须消失**（只断言前者会放过"两句同时挂着的"那种写法）；
//   ② 成功 ⇒ 一个 alert 都不许有，主体照常渲染。
// 读数器分两个：`toasts()` 数 role=status（toast 面板），`alerts()` 数 role=alert（常驻那句）——
// 这正是 LoadFailNotice 用 alert 而不是 status 的原因：混在同一个读数里就分不开"弹过一条"与"此刻仍读不到"。
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DataHealthReport, OllamaRuntimeStatus, UsageAssistantItem, UsageConversationItem, UsagePricing, UsageSummary } from '../src/shared/types'

const ZH = zh as unknown as Record<string, string>
const L = (key: string): string => ZH[key]!
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
/** 界面事实的两句：常驻那句应长成这样，而「加载中…」这时必须不在场 */
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settleAfter = async (fn: string): Promise<void> => {
  await waitFor(() => expect(calledFns()).toContain(fn))
  await settle()
}

const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* jsdom 没有布局，滚动是空操作 */ }
})

const report = (): DataHealthReport => ({
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
})

describe('① 数据健康面板：失败时本体不许顶着「加载中…」', () => {
  it('getDataHealth 回 {ok:false} ⇒ 常驻那句给出原因，「加载中…」消失', async () => {
    stubPocketai({ getDataHealth: () => FAIL })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
    // toast 仍然弹一条（§221 的读数不变），两句并存而不是互相替换
    expect(toasts()).toEqual(['库被占用'])
  })

  it('反向对照：读到了 ⇒ 报告照常渲染、一个 alert 都没有', async () => {
    stubPocketai({ getDataHealth: () => report() })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(alerts()).toEqual([])
    expect(screen.getByText(L('dh.db'))).toBeTruthy()
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })
})

const summary = (requests: number): UsageSummary => ({
  days: 30,
  totals: { requests, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost: 0 },
  daily: [],
  byProvider: [],
  byModel: []
})

const okReads = {
  getUsageConversations: () => [] as UsageConversationItem[],
  getUsageAssistants: () => [] as UsageAssistantItem[],
  getUsagePricing: () => ({ currency: 'CNY', prices: {} } as unknown as UsagePricing),
  getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
}

describe('② 用量汇总：整张面板的数据源读不到时，说的是「读不到」而不是「加载中…」', () => {
  it('getUsageSummary 回 {ok:false} ⇒ alert 那句给出原因，且「加载中…」「暂无用量数据」两句都不许在', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => FAIL })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
    expect(screen.queryByText(L('usage.noData'))).toBeNull()
  })

  it('反向对照：读到 7 次 ⇒ 卡片显示 7，一个 alert 都没有', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => summary(7) })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(alerts()).toEqual([])
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('先读失败再读成功 ⇒ 那句「读不到」必须跟着消失（不能赖在界面上）', async () => {
    let first = true
    stubPocketai({
      ...okReads,
      getUsageSummary: () => {
        if (first) { first = false; return FAIL }
        return summary(7)
      }
    })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(alerts()).toEqual([FAILED('库被占用')])
    fireEvent.click(screen.getByRole('button', { name: L('usage.days7') }))
    await waitFor(() => expect(calledFns().filter((f) => f === 'getUsageSummary').length).toBe(2))
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.getByText('7')).toBeTruthy()
  })

  it('单价表格里那一格同口径：listUsageModels 失败 ⇒ 行里是「读不到」，不是「加载中…」', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => summary(7), listUsageModels: () => FAIL })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
    await settleAfter('listUsageModels')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })

  it('反向对照：拉到两个模型 ⇒ 表格里列出行，一个 alert 都没有', async () => {
    stubPocketai({
      ...okReads,
      getUsageSummary: () => summary(7),
      listUsageModels: () => [
        { provider: 'openai', model: '探针甲', requests: 1, totalTokens: 1, cost: 0 },
        { provider: 'openai', model: '探针乙', requests: 1, totalTokens: 1, cost: 0 }
      ]
    })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('usage.priceSettings')) }))
    await settleAfter('listUsageModels')
    expect(alerts()).toEqual([])
    expect(screen.getByText('探针甲')).toBeTruthy()
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })
})

const ollamaStatus = (): OllamaRuntimeStatus => ({
  platformSupported: true, installed: true, running: true, source: 'portable', version: '0.9.9',
  installDir: 'runtime/ollama-test', modelsDir: 'data/ollama-models', downloadUrl: null, downloadBytes: null, models: []
})

describe('③ Ollama 面板：这块每 8s 轮询一次，所以失败只留常驻那句、不弹 toast', () => {
  const stubs = (status: () => unknown): Record<string, () => unknown> => ({
    getOllamaStatus: status,
    getOllamaMirror: () => ({ ok: true, mirror: '' }),
    // 推荐卡片不是本批的判据对象（那条通道是"设计内 {ok,data}"形状），给一个不落到 setRec 的桩
    recommendModels: () => ({ ok: true, data: null }),
    onOllamaInstallEvent: () => () => { /* 订阅卸载函数 */ },
    onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ }
  })

  it('读不到 ⇒ 「读不到：原因」在，且不弹 toast（轮询失败刷屏就是这里）、状态区不再整块空着', async () => {
    stubPocketai(stubs(() => FAIL))
    mountWithProviders(<OllamaPanel />)
    await settleAfter('getOllamaStatus')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(toasts()).toEqual([])
  })

  it('反向对照：读到运行中 ⇒ 没有 alert，标题右侧那枚来源徽标照常渲染', async () => {
    stubPocketai(stubs(() => ollamaStatus()))
    mountWithProviders(<OllamaPanel />)
    await settleAfter('getOllamaStatus')
    expect(alerts()).toEqual([])
    // 徽标那句和版本号在同一个 <span> 里（`便携版运行中 · 0.9.9`）⇒ 用子串匹配，别写成整块 textContent
    expect(screen.getAllByText(L('ollama.portableSource'), { exact: false }).length).toBeGreaterThan(0)
  })

  it('8s 轮询的下一发读到 ⇒ 那句「读不到」让位给真状态（门在"还没有数据"那一侧，不靠清状态）', async () => {
    let first = true
    stubPocketai(stubs(() => {
      if (first) { first = false; return FAIL }
      return ollamaStatus()
    }))
    vi.useFakeTimers()
    try {
      mountWithProviders(<OllamaPanel />)
      await act(async () => { vi.advanceTimersByTime(0) })
      expect(alerts()).toEqual([FAILED('库被占用')])
      await act(async () => { vi.advanceTimersByTime(8000) })
      await act(async () => { vi.advanceTimersByTime(0) })
      expect(alerts()).toEqual([])
      expect(screen.getAllByText(L('ollama.portableSource'), { exact: false }).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
