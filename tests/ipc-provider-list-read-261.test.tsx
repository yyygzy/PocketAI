// V4-Iter-261：CAP 递减第七簇——Agent 挂载时那两发清单读（服务商／助手），失败对象不再当数组用。
//
// 探针实测（临时用例，跑完即删）两种谎法，都不是"看着像没配"：
//  · `listProviders` 回 `{ok:false}` ⇒ `ps.filter` 当场 TypeError，被那句 `.catch` 当成"通道失败"念进 console，
//    **assistants 明明读到了也一起丢** ⇒ 两份都是空数组（屏上＝服务商与助手都空，一句提示都没有）；
//  · `listAssistants` 回 `{ok:false}` ⇒ 对象被原样写进 `assistants` ⇒ `SessionRail` 渲染时
//    **`assistants.map is not a function`**、`document.body.textContent` 长度 **0**（真应用里＝整站崩溃屏）。
//
// 收口沿用 §259／§260 那张脸：两发各判各的（`hasIpcFailed(x)` 或 `!Array.isArray(x)`）、各说各的、
// 成功即收回；失败侧**不写 state**（这两份是全局清单，挂载与"从设置页切回来"重拉都是同一份的刷新 ⇒
// 保持上一份比清空诚实，清空会把"刚在设置里建好一个服务商"演成"助手全没了"）。
// 那两句放在 AgentPanel 而不是 SessionRail：侧栏收起时藏在折叠后面的那句等于没说（§257 同一条口径）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useProviderData } from '../src/renderer/src/modules/agent/hooks/useProviderData'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { useAppStore } from '../src/renderer/src/store/app-store'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ConversationRecord, MessageRecord, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''

type Impl = (...a: any[]) => unknown
const GLM = { id: 'glm', name: '智谱 GLM', enabled: true, models: ['glm-4.6'] } as unknown as ProviderRecord
const OFF = { id: 'off', name: '停用那家', enabled: false, models: [] } as unknown as ProviderRecord
const A1 = { id: 'a1', name: 'a1', isBuiltin: false, isPinned: false, avatar: '🤖' }
const PARENT = { id: 'c1', assistantId: 'a1', title: '父会话', modelLabel: 'glm-4.6' } as unknown as ConversationRecord

const stubBase = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listProviders: () => [GLM, OFF],
  listAssistants: () => [A1],
  getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
  setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
  listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) => (archivedOnly ? [] : [PARENT]),
  listMessages: (id: string) =>
    [{ id: `m-${id}`, conversationId: id, role: 'user', content: '跑一趟', createdAt: 1 }] as MessageRecord[],
  getLatestRunStats: () => null,
  getSessionStats: () => ({ runCount: 0, totalDurationMs: 0, totalTokens: 0 }),
  getLatestRunTraces: () => [],
  getAgentTextProtocol: () => [],
  getModelContextWindows: () => ({}),
  getFallbackTargets: () => ({}),
  setFallbackTarget: () => ({ targets: {} }),
  getConversation: () => null,
  listChildConversations: () => [],
  getAgentWorkspaceDir: () => '',
  getShellConfig: () => ({}),
  getWebSearchConfig: () => ({}),
  getCalendarConfig: () => ({}),
  fetchModels: () => ({ ok: true }),
  sendMessage: () => ({ ok: true }),
  abortAgent: () => ({ ok: true }),
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

const run = (over: Record<string, Impl> = {}) => {
  stubPocketai(stubBase(over))
  return renderHook(() => useProviderData(), { wrapper: HookProviders })
}

/** 这个 hook 重拉的唯一真路就是"切回 Agent 那一屏"（第二个 effect 为此存在）。
    两次切换必须分开两个 act：同一个 act 里 React 会把它合并成"值没变"，effect 不会重跑。 */
const backToAgent = async (): Promise<void> => {
  await act(async () => { useAppStore.getState().switchModule('settings') })
  await act(async () => {
    useAppStore.getState().switchModule('agent')
    await new Promise((r) => setTimeout(r, 25))
  })
}

describe('① 两发各判各的：一发失败不许带走另一发', () => {
  it('两发都回 {ok:false} ⇒ 两份都还是数组（空），两句各点各的名', async () => {
    const { result } = run({
      listProviders: () => ({ ok: false, error: 'PROV:服务商读不到' }),
      listAssistants: () => ({ ok: false, error: 'ASST:助手读不到' })
    })
    await waitFor(() => expect(result.current.providersUnread).not.toBeNull())
    expect(Array.isArray(result.current.providers)).toBe(true)
    expect(Array.isArray(result.current.assistants)).toBe(true)
    expect(result.current.providers).toEqual([])
    expect(result.current.assistants).toEqual([])
    expect(result.current.providersUnread).toEqual({ error: 'PROV:服务商读不到' })
    expect(result.current.assistantsUnread).toEqual({ error: 'ASST:助手读不到' })
  })

  it('只服务商那发失败 ⇒ 助手照常写进去（这条就是"带走"那一档的牙）＋只点服务商那句', async () => {
    const { result } = run({ listProviders: () => ({ ok: false, error: 'PROV:服务商读不到' }) })
    await waitFor(() => expect(result.current.assistantsUnread).toBeNull())
    expect(result.current.assistants).toEqual([A1])
    expect(result.current.providers).toEqual([])
    expect(result.current.providersUnread).toEqual({ error: 'PROV:服务商读不到' })
  })

  it('只助手那发失败 ⇒ 服务商清单照常（含只留 enabled 那道过滤），失败对象绝不进 assistants', async () => {
    const { result } = run({ listAssistants: () => ({ ok: false, error: 'ASST:助手读不到' }) })
    await waitFor(() => expect(result.current.assistantsUnread).toEqual({ error: 'ASST:助手读不到' }))
    expect(result.current.providers.map((p) => p.id)).toEqual(['glm'])
    expect(Array.isArray(result.current.assistants), '写进 state 的必须是数组（SessionRail 的 .map 等着）').toBe(true)
    expect(result.current.assistants).toEqual([])
    expect(result.current.providersUnread).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 两句都是 null，且停用的那家被过滤掉', async () => {
    const { result } = run()
    await waitFor(() => expect(result.current.providers.length).toBeGreaterThan(0))
    expect(result.current.providers.map((p) => p.id)).toEqual(['glm'])
    expect(result.current.assistants).toEqual([A1])
    expect(result.current.providersUnread).toBeNull()
    expect(result.current.assistantsUnread).toBeNull()
  })

  it('读到了但不是数组（信封串位／旧形状）⇒ 按读不到处理，error 留空由界面兜底', async () => {
    const { result } = run({
      listAssistants: () => ({ ok: true, data: [A1] }) as unknown as typeof A1[]
    })
    await waitFor(() => expect(result.current.assistantsUnread).toEqual({ error: undefined }))
    expect(result.current.assistants, '形状不符也不许写进 state').toEqual([])
    expect(result.current.providers).toEqual([GLM])
    expect(result.current.providersUnread).toBeNull()
  })

  it('reject 面（通道本身抛了）⇒ 两句都用抛出的原文，两份都还是数组', async () => {
    const { result } = run({
      listProviders: () => Promise.reject(new Error('服务商通道炸了')),
      listAssistants: () => Promise.reject(new Error('服务商通道炸了'))
    })
    await waitFor(() => expect(result.current.providersUnread).toEqual({ error: '服务商通道炸了' }))
    expect(result.current.assistantsUnread).toEqual({ error: '服务商通道炸了' })
    expect(result.current.providers).toEqual([])
    expect(result.current.assistants).toEqual([])
  })

  it('切回 Agent 那一屏时重拉，而这一发失败 ⇒ 保持上一份＋那句，恢复后自己收回', async () => {
    let failing = false
    const { result } = run({
      listProviders: () => (failing ? { ok: false, error: 'PROV:刷新挂了' } : [GLM, OFF]),
      listAssistants: () => (failing ? { ok: false, error: 'ASST:刷新挂了' } : [A1])
    })
    await waitFor(() => expect(result.current.providers.map((p) => p.id)).toEqual(['glm']))
    expect(result.current.assistants).toEqual([A1])

    failing = true
    await backToAgent()
    expect(result.current.providers, '清空会把"刚在设置页建好一家服务商"演成"一家都没有"').toEqual([GLM])
    expect(result.current.assistants).toEqual([A1])
    expect(result.current.providersUnread).toEqual({ error: 'PROV:刷新挂了' })
    expect(result.current.assistantsUnread).toEqual({ error: 'ASST:刷新挂了' })

    failing = false
    await backToAgent()
    expect(result.current.providersUnread).toBeNull()
    expect(result.current.assistantsUnread).toBeNull()
    await act(async () => { useAppStore.getState().switchModule('chat') })
  })
})

describe('② AgentPanel 真挂载：两句各点各的名，屏上仍有内容', () => {
  it('两发都读不到 ⇒ 屏上不是空白，两句都在，且没有整站崩溃兜底屏', async () => {
    stubPocketai(stubBase({
      listProviders: () => ({ ok: false, error: 'PROV:服务商读不到' }),
      listAssistants: () => ({ ok: false, error: 'ASST:助手读不到' })
    }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('服务商列表', 'PROV:服务商读不到')))
    expect(alerts()).toContain(NAMED('助手列表', 'ASST:助手读不到'))
    // 这一条才是本批的立项理由：以前 assistants 是失败对象 ⇒ .map TypeError ⇒ 整屏一个字都不剩
    expect(bodyText().length, '屏上仍有内容（探针实测旧形状是 0）').toBeGreaterThan(0)
    expect(bodyText()).not.toContain('undefined')
  })

  it('只助手那发读不到 ⇒ 服务商照常出现在模型栏，且不说「服务商列表读不到」', async () => {
    stubPocketai(stubBase({ listAssistants: () => ({ ok: false, error: 'ASST:助手读不到' }) }))
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('助手列表', 'ASST:助手读不到')))
    expect(screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim())).toContain('智谱 GLM')
    expect(alerts().join(' ')).not.toContain('服务商列表读不到')
  })

  it('反向对照：两发都读到 ⇒ 屏上一句「读不到」都没有', async () => {
    stubPocketai(stubBase())
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(screen.getAllByText('父会话').length).toBeGreaterThan(0))
    expect(alerts()).toEqual([])
  })
})

describe('③ 接线计数', () => {
  const blankComments = (code: string): string =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}${' '.repeat(_m.length - p1.length - 1)}`)
  const read = (rel: string): string =>
    blankComments(fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n'))
  const HOOK = read('src/renderer/src/modules/agent/hooks/useProviderData.ts')
  const PANEL = read('src/renderer/src/modules/agent/chat/AgentPanel.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('两发各判一次、各写一次，旧"拿到就 filter／拿到就写"归零', () => {
    expect(count(HOOK, /if \(hasIpcFailed\(ps\) \|\| !Array\.isArray\(ps\)\)/g)).toBe(1)
    expect(count(HOOK, /if \(hasIpcFailed\(as_\) \|\| !Array\.isArray\(as_\)\)/g)).toBe(1)
    expect(count(HOOK, /^\s*setProviders\(ps\.filter/mg), '成功支只剩判过之后那一处').toBe(1)
    expect(count(HOOK, /^\s*setAssistants\(as_\)/mg)).toBe(1)
    expect(count(HOOK, /setProvidersUnread\(null\)/g), '成功即收回').toBe(1)
    expect(count(HOOK, /setAssistantsUnread\(null\)/g)).toBe(1)
    expect(count(HOOK, /\.catch\(reportIpcError/g), '.catch 裸交出去那一形归零').toBe(0)
  })

  it('那两句真传到 AgentPanel，且挂在收起态也看得见的位置', () => {
    expect(count(PANEL, /providersUnread, assistantsUnread/g), '从 hook 解构出来').toBe(1)
    expect(count(PANEL, /<LoadFailNotice what=\{t\('agent\.providersList'\)}/g)).toBe(1)
    expect(count(PANEL, /<LoadFailNotice what=\{t\('agent\.assistantsList'\)}/g)).toBe(1)
    const bar = PANEL.indexOf('<AgentToolBars tools={tools} />')
    const notice = PANEL.indexOf('providersUnread && (')
    expect(notice, '两句在工具栏之前（侧栏收起也在场）').toBeGreaterThan(-1)
    expect(notice, '两句在 <AgentToolBars/> 之前').toBeLessThan(bar)
  })
})
