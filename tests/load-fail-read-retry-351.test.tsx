// @vitest-environment jsdom
// V4-Iter-351：§350 那把尺子的第二档与两处漏数——把"这一发的重拉在别处"递到失败脸旁边。
//
// 覆盖两处能便宜演行为的落点：
//  · 许可证那一屏：整块面板在 `lic === null` 时 early-return，四颗动作键与 §345 那颗「重试」都长在
//    本体里 ⇒ 首读失败这一屏原本按不动任何东西。补的这颗走的正是那四颗键共用的 `onChange`（＝`licCopy.refresh`）。
//  · 设置页「单价设置」展开后的模型清单：§347 把"逐渲染重读"收干成 `reloadModels` 之后，
//    那一发只剩挂载一个读者 ⇒ 失败时同屏没人再跑它；收起再展开算重新挂载、不算出口（P2 已钉住这一点）。
//    所以这一处**不挂旧值横幅**（§347 判过：横幅无落点），但**该有一颗重试**——那是 §350 当时漏数的一条：
//    loader 早就在作用域里，被我错分成"要先抽 loader"那一档。
// 其余四处（AgentPanel 两发、会话栏两发）本轮只有闸门 `load-fail-read-retry-gate-350.test.ts` 看得见：
// 那两块要挂整页面板或整棵侧栏，夹具代价与 §345 的"演不出的一格"同一档，账写在台账里。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { LicensePanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  UsageAssistantItem,
  UsageConversationItem,
  UsageModelItem,
  UsagePricing,
  UsageSummary
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const RETRY = L('agent.retryRead')
const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

describe('许可证那一屏：首读就失败 ⇒ early-return 那一支也得自带出口', () => {
  it('键在同级、不在那条 alert 里；按下去调的就是四颗动作键共用的 onChange', () => {
    // 面板自己还会拉指纹（§294 那颗键的数据源）：不 stub 就是 `window.pocketai.getLicenseFingerprint is not a function`
    stubPocketai({ getLicenseFingerprint: () => 'fp-1234' })
    let refreshes = 0
    mountWithProviders(<LicensePanel lic={null} err={'库被占用'} onChange={() => { refreshes++ }} />)
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('license-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(key.closest('[role="alert"]')).toBeNull()
    // 本体（四颗动作键、到期日、§346 那颗 `lic-stale-retry`）此刻根本不在屏上——这正是这一支原来没出口的原因
    expect(screen.queryByTestId('lic-stale-retry')).toBeNull()

    fireEvent.click(key)
    expect(refreshes).toBe(1)
  })
})

describe('单价设置那份模型清单：首读就失败 ⇒ 那一格补一颗走 `reloadModels` 的键', () => {
  const summary = (): UsageSummary =>
    ({
      days: 30, totals: { requests: 3, promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, cost: 0 },
      daily: [], byProvider: [], byModel: []
    }) as unknown as UsageSummary
  const okReads = {
    getUsageSummary: () => summary(),
    getUsageConversations: () => [] as UsageConversationItem[],
    getUsageAssistants: () => [] as UsageAssistantItem[],
    getUsagePricing: () => ({ currency: 'CNY', prices: {} }) as unknown as UsagePricing,
    getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
  }

  it('展开⇒那一发失败：那句与那颗键同屏；按键真再发一发；到货后那句收回、空态说话', async () => {
    stubPocketai({ ...okReads, listUsageModels: () => FAIL })
    mountWithProviders(<UsagePanel />)
    await waitFor(() => expect(callsOf('getUsageSummary')).toBe(1))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /单价设置/ }))
    await waitFor(() => expect(callsOf('listUsageModels')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('price-models-read-retry')
    expect(key.closest('[role="alert"]')).toBeNull()
    // 这一格判过不挂旧值横幅（§347）：那一颗键必须是唯一出口，不是第二颗同义键
    expect(screen.queryByTestId('price-models-stale-retry')).toBeNull()

    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listUsageModels')).toBe(2))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])

    stubPocketai({ ...okReads, listUsageModels: () => [] as UsageModelItem[] })
    fireEvent.click(screen.getByTestId('price-models-read-retry'))
    await waitFor(() => expect(callsOf('listUsageModels')).toBe(3))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getByText(L('usage.priceNoModels'))).toBeTruthy()
  })
})
