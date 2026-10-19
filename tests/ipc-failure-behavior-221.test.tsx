// @vitest-environment jsdom
// V4-Iter-221：`.then(...)` 那条面上的 92 个点收口之后，挑三处"改前会怎样"是**看得见**的来演行为。
//
// 217/219/221 的闸门给的是源码级证据（分类器读得出、摘掉守卫会红）。这一批要演的是另外两件事：
//   ① 失败对象写进 state 之后界面**当场崩**（解构／`.map`／`.find`）——这一条只有真挂载能证；
//   ② 惰性拉取那一族：改前把 `{ok:false}` 写进 ref（真值）⇒ 这个组件此生不再重拉，界面上永远是"空清单"。
// 每条都配反向对照：把"失败要说话"改成"成功也说话"同样是回归。
//
// 没被这三条覆盖到的点（多数是"失败就停在上一份数据"的纯读面）只有闸门；
// 而"停在上一份"与"读不到"在界面上还分不开（首屏就是「加载中」），那一条如实记在台账的未修项里。
import { describe, it, expect, beforeAll } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { PromptSnippetRecord, UsageAssistantItem, UsageConversationItem, UsagePricing, UsageSummary } from '../src/shared/types'

const ZH = zh as unknown as Record<string, string>
// jsdom 不提供 scrollIntoView，而 SlashMenu 在 activeIndex 变化时会调它 ⇒ 不补这一句，本文件会留一条
// Unhandled Errors（vitest 明说这类错误可能造成假绿）。补在挂载之前，测试逻辑不受影响。
beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* jsdom 没有布局，滚动是空操作 */ }
})
const L = (key: string): string => ZH[key]!
/** 每条 toast 自己就是一个 role=status 的盒子；不滤空串（§218 的教训：滤掉就放过了"既报错又报成功"） */
const panels = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
/** 等那次 IPC 真落地，再同步断言（§218：waitFor(...toEqual([X])) 第一拍就可能成立） */
const settleAfter = async (fn: string): Promise<void> => {
  await waitFor(() => expect(calledFns()).toContain(fn))
  await settle()
}

const FAIL = { ok: false, error: '库被占用' }

const summary = (requests: number): UsageSummary => ({
  days: 30,
  totals: { requests, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost: 0 },
  daily: [],
  byProvider: [],
  byModel: []
})

describe('① 数据健康面板：改前把失败对象当报告用，解构当场崩', () => {
  it('getDataHealth 回 {ok:false} ⇒ 面板不崩，toast 逐字给原因', async () => {
    stubPocketai({ getDataHealth: () => FAIL })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(panels()).toEqual(['库被占用'])
    // 报告主体一个格子都不许出现（改前正是从这里 TypeError）
    expect(screen.queryByText(L('dh.db'))).toBeNull()
  })

  it('反向对照：读到了 ⇒ 报告渲染出来，且不弹任何东西', async () => {
    stubPocketai({
      getDataHealth: () => ({
        sizes: {
          userDataBytes: 1024, dbBytes: 1024, attachmentsBytes: 1024, extensionsBytes: 1024, logsBytes: 1024,
          otherBytes: 0, browserCacheBytes: 0, browserCacheFiles: 0
        },
        traces: { rows: 0, maxRowsInOneConversation: 0 },
        kb: { total: 0, byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 }, errorDocs: [], integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] }, vectorIndex: { count: 0, dims: [] } },
        backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
        tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
        boot: { stages: [], totalMs: 0 },
        recentPerf: [],
        perfHistory: []
      })
    })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(panels()).toEqual([])
    expect(screen.getByText(L('dh.db'))).toBeTruthy()
  })
})

describe('② 用量面板：三条读都是"报告的数据源"，失败不许冒出「暂无用量数据」', () => {
  const okReads = {
    getUsageConversations: () => [] as UsageConversationItem[],
    getUsageAssistants: () => [] as UsageAssistantItem[],
    getUsagePricing: () => ({ currency: 'CNY', prices: {} } as unknown as UsagePricing),
    getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
  }

  it('getUsageSummary 回 {ok:false} ⇒ toast 逐字「操作失败：库被占用」，不出现「暂无用量数据」那句谎', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => FAIL })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(panels()).toEqual([L('common.opFailed').replace('{msg}', '库被占用')])
    expect(screen.queryByText(L('usage.noData'))).toBeNull()
  })

  it('反向对照：读到 7 次请求 ⇒ 那张卡片显示 7，且没有 toast', async () => {
    stubPocketai({ ...okReads, getUsageSummary: () => summary(7) })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(panels()).toEqual([])
    expect(screen.getByText(L('usage.requests'))).toBeTruthy()
    expect(screen.getByText('7')).toBeTruthy()
  })
})

describe('③ Composer 的 /# 片段菜单：失败既不能写进 ref，也不能把惰性拉取变成"每次渲染重拉一趟"', () => {
  const props = { streaming: false, canSend: true, noModels: false, onSend: () => {}, onStop: () => {}, draftKey: 'c1' }
  const type = (v: string): void => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: v } })
  }
  const fetchCount = (): number => calledFns().filter((f) => f === 'listPromptSnippets').length

  it('拉失败 ⇒ 输入框还活着（改前 `{ok:false}` 进 ref，重建菜单那句 `.map` 当场 TypeError），且只拉一次', async () => {
    stubPocketai({ listPromptSnippets: () => FAIL, listKnowledgeBases: () => [] })
    mountWithProviders(<Composer {...props} />)
    type('#')
    await settleAfter('listPromptSnippets')
    type('')
    type('#')
    type('#ab')
    await settle()
    // 这一条钉的是 §221 落地时自己踩出来的坑：失败后把惰性 ref 清回 null，
    // 而这根 effect 的依赖是每次渲染新建的 triggerInfo 对象 ⇒ 每次渲染重拉，输入框卡死
    expect(fetchCount()).toBe(1)
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(panels()).toEqual([])
  })

  it('反向对照：拉到 ⇒ 菜单里有那条片段，缓存生效同样只拉一次', async () => {
    stubPocketai({
      listPromptSnippets: () => [{ id: 's1', title: '探针片段', content: 'hello' } as unknown as PromptSnippetRecord],
      listKnowledgeBases: () => []
    })
    mountWithProviders(<Composer {...props} />)
    type('#')
    await settleAfter('listPromptSnippets')
    expect(screen.getByText('#探针片段')).toBeTruthy()
    type('')
    type('#')
    await settle()
    expect(fetchCount()).toBe(1)
  })
})
