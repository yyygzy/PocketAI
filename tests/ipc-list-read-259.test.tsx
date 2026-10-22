// V4-Iter-259：§258 名单里"还会当场崩"的那两条同族点——Agent 的会话列表两发 ＋ MCP 的清单与运行状态两发。
//
// 探针实测（两份临时用例，跑完即删）：
//  · `listConversations` 回 `{ok:false,error}` ⇒ 失败对象被当数组写进 state ⇒ **`chat.conversations.find is not a function`**
//    （`AgentPanel.tsx:148`），整屏一个字都不剩（真应用里由根层 AppErrorBoundary 接住＝整站崩溃屏）；
//  · `listMcpServers` 同形状 ⇒ **`records.map is not a function`**（`McpPanel.tsx:301`），同样整屏空白。
// 两条都是"绑了变量、只判真值（或根本不判）就把失败对象当数据用"这一档，第四面闸门看不见它们
// （判的是变量，不是信封），所以 §258 只能靠只读扫描把它们捞出来。
//
// 收口形状照仓里既有的脸，且**逐发点名**（§257 的口径）：活跃读到而归档没读到，不该把读到的那份也一起扔了，
// 也不该把两句合并成一句"整屏不可信"。两处的清空策略不同，是有意为之：
//  · 切换助手 ⇒ 清空（上一份属于别的助手，留着更会骗人）；
//  · 刷新（置顶／归档／导入之后）⇒ 保持上一份（清空会把"刚归档完这一条"演成"整列消失"）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { zh } from '../src/renderer/src/i18n/zh'
import { requestOpenConversation } from '../src/renderer/src/utils/palette-nav'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''

// ───────── ① MCP 那两张表 ─────────

const RECORD = {
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, headers: {}, enabled: true, readOnly: false, url: ''
}
const RUNTIME = [{
  id: 'srv1', name: '探针服务', transport: 'stdio', runtime: 'binary', command: 'node',
  args: [], env: {}, status: 'running', tools: [], lastError: null
}]

type Impl = (...a: any[]) => unknown
const mcpStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listMcpServers: () => [RECORD],
  getMcpRuntimes: () => RUNTIME,
  listMcpCallLogs: () => ({ ok: true, logs: [] }),
  onMcpStatus: () => () => { /* 订阅卸载 */ },
  onMcpLog: () => () => { /* 订阅卸载 */ },
  onPythonEnvEvent: () => () => { /* 订阅卸载 */ },
  getPythonPipSource: () => ({ ok: true, source: 'default', url: '' }),
  ...over
})

describe('① MCP 的清单与运行状态：两发各自点名，且这一屏不许再是空白', () => {
  it('两发都回 {ok:false} ⇒ 两句各说各的，空态「尚未配置」让位，屏上仍有内容', async () => {
    stubPocketai(mcpStubs({
      listMcpServers: () => ({ ok: false, error: 'MCP_LIST:配置文件读不到' }),
      getMcpRuntimes: () => ({ ok: false, error: 'RUNTIME:状态读不到' })
    }))
    mountWithProviders(<McpPanel />)
    // DOM 序就是这两句的顺序（运行状态那句在列表上方做整列的注脚，清单那句占的是空态那一格）
    await waitFor(() => expect(alerts()).toEqual([
      L('agent.runtimeUnread').replace('{msg}', 'RUNTIME:状态读不到'),
      NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')
    ]))
    // 这一条才是本批的立项理由：以前 records 是失败对象 ⇒ map TypeError ⇒ 整屏空白
    process.stdout.write(`DBG-ALERTS=${JSON.stringify(alerts())}
DBG-BODY=${JSON.stringify(bodyText().slice(0,160))}
`)
    expect(bodyText()).toContain('MCP Servers')
    expect(bodyText()).not.toContain(L('agent.noServers'))
    expect(bodyText()).not.toContain('undefined')
  })

  it('只有清单读不到 ⇒ 那句在，运行状态那句不许顺带冒（逐发点名）', async () => {
    stubPocketai(mcpStubs({ listMcpServers: () => ({ ok: false, error: 'MCP_LIST:配置文件读不到' }) }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')))
    expect(alerts().join(' ')).not.toContain('运行状态读不到')
    // 清单没读到 ⇒ 一张卡都不该有（那句占的就是空态那一格）
    expect(screen.queryAllByRole('button', { name: L('common.stop') })).toEqual([])
  })

  it('只有运行状态读不到 ⇒ 服务器照常列出（读到的那份不能被一起扔了），且没有「尚未配置」', async () => {
    stubPocketai(mcpStubs({ getMcpRuntimes: () => ({ ok: false, error: 'RUNTIME:状态读不到' }) }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(L('agent.runtimeUnread').replace('{msg}', 'RUNTIME:状态读不到')))
    // 这个名字会同时出现在卡片与"调用记录"的过滤项里 ⇒ 断"至少一处"而不是断唯一
    expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0)
    expect(bodyText()).not.toContain(L('agent.noServers'))
    expect(screen.queryAllByRole('button', { name: L('common.start') }), '运行状态没读到 ⇒ 每台按未启动显示').not.toEqual([])
    expect(alerts().join(' ')).not.toContain('MCP 服务器列表读不到')
  })

  it('反向对照：两发都读到 ⇒ 一句"读不到"都不许有', async () => {
    stubPocketai(mcpStubs())
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0))
    expect(alerts()).toEqual([])
  })

  it('后来到货（从模板建了一台）⇒ 那两句必须自己收回', async () => {
    let failing = true
    stubPocketai(mcpStubs({
      listMcpServers: () => (failing ? { ok: false, error: 'MCP_LIST:配置文件读不到' } : [RECORD]),
      getMcpRuntimes: () => (failing ? { ok: false, error: 'RUNTIME:状态读不到' } : RUNTIME),
      saveMcpServer: () => ({ ...RECORD, name: 'memory' })
    }))
    mountWithProviders(<McpPanel />)
    await waitFor(() => expect(alerts()).toContain(NAMED('MCP 服务器列表', 'MCP_LIST:配置文件读不到')))
    fireEvent.click(screen.getByText(L('agent.templates')))
    const card = await waitFor(() => screen.getByText('memory').closest('div[class*="rounded"]') as HTMLElement)
    const btn = Array.from(card.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === L('agent.tplCreate'))
    if (!btn) throw new Error('模板卡片 memory 上找不到「创建」按钮')
    failing = false
    fireEvent.click(btn)
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getAllByText('探针服务').length).toBeGreaterThan(0)
  })
})

// ───────── ② Agent 会话列表那两发 ─────────

const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai-compatible', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [
  { id: 'a1', name: 'a1', isBuiltin: false, isPinned: false },
  { id: 'a2', name: 'a2', isBuiltin: false, isPinned: false }
] as unknown as AssistantRecord[]
const CONV = { id: 'c1', assistantId: 'a1', title: '会话一', modelLabel: 'm1' } as unknown as ConversationRecord

const chatStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listProviders: () => PROVIDERS,
  listAssistants: () => ASSISTANTS,
  getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
  setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
  listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) =>
    archivedOnly ? [] : [CONV],
  listMessages: () => [],
  getLatestRunStats: () => null,
  getSessionStats: () => null,
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
  sendMessage: () => ({ ok: true }),
  abortAgent: () => ({ ok: true }),
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

describe('② 会话列表那两发：失败对象绝不进 state', () => {
  const run = () => renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })

  it('两发都回 {ok:false} ⇒ 两份都还是数组（空），两句各自点名，且没有选中的会话', async () => {
    stubPocketai(chatStubs({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        ({ ok: false, error: archivedOnly ? 'CONV_ARCH:归档读不到' : 'CONV_ACTIVE:列表读不到' })
    }))
    const { result } = run()
    await waitFor(() => expect(result.current.conversationsUnread).not.toBeNull())
    expect(Array.isArray(result.current.conversations), '失败对象不许当列表用（以前这一步就埋下 .find TypeError）').toBe(true)
    expect(Array.isArray(result.current.archivedConversations)).toBe(true)
    expect(result.current.conversations).toEqual([])
    expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:列表读不到' })
    expect(result.current.archivedUnread).toEqual({ error: 'CONV_ARCH:归档读不到' })
    expect(result.current.conversationId, '选不出会话就回 null，不拿旧助手的那条留着').toBeNull()
  })

  it('只有归档那发读不到 ⇒ 活跃列表照常在、只点归档那一句（逐发点名）', async () => {
    stubPocketai(chatStubs({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        archivedOnly ? { ok: false, error: 'CONV_ARCH:归档读不到' } : [CONV]
    }))
    const { result } = run()
    await waitFor(() => expect(result.current.archivedUnread).toEqual({ error: 'CONV_ARCH:归档读不到' }))
    expect(result.current.conversations).toEqual([CONV])
    expect(result.current.conversationsUnread).toBeNull()
    expect(result.current.conversationId, '活跃那半读到了 ⇒ 照旧自动选中最近一条').toBe('c1')
  })

  it('跨助手跳一条"只在归档里"的会话，而归档那发恰好读不到 ⇒ 照样切过去，只是拿不到 modelLabel', async () => {
    // 这一条给"只挂归档那半时照常选"这个口径装牙：`findConv` 只在**助手切换 effect 消费 pending** 那条路上用到
    // （同助手跳转是直接 setConversationId，不查表）。写成 S12 那样的旧形状（拿失败对象去 find）会当场 TypeError。
    const CONV2 = { id: 'c2', assistantId: 'a2', title: '另一助手', modelLabel: 'm1' } as unknown as ConversationRecord
    stubPocketai(chatStubs({
      listConversations: (assistantId: string, _x: boolean, archivedOnly?: boolean) => {
        if (assistantId === 'a1') return [CONV]
        return archivedOnly ? { ok: false, error: 'CONV_ARCH:归档读不到' } : [CONV2]
      }
    }))
    const { result } = run()
    await waitFor(() => expect(result.current.conversations).toEqual([CONV]))
    await act(async () => {
      // 走命令面板那条真路（`requestOpenConversation` 才会把 pending 存下来给助手切换 effect 消费）
      requestOpenConversation({ isAgent: true, assistantId: 'a2', conversationId: 'arch-only-9' })
    })
    await waitFor(() => expect(result.current.conversationId).toBe('arch-only-9'))
    expect(result.current.archivedUnread, '归档那半的失败仍然要说出来')
      .toEqual({ error: 'CONV_ARCH:归档读不到' })
  })

  it('反向对照：两发都读到 ⇒ 两句都是 null', async () => {
    stubPocketai(chatStubs())
    const { result } = run()
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(result.current.conversationsUnread).toBeNull()
    expect(result.current.archivedUnread).toBeNull()
  })

  it('刷新那一发失败 ⇒ 上一份列表保持原样（清空会把"刚归档完这条"演成"整列消失"）＋那句点名', async () => {
    let failing = false
    stubPocketai(chatStubs({
      listConversations: (_a: string, _x: boolean, archivedOnly?: boolean) =>
        failing ? { ok: false, error: `CONV_${archivedOnly ? 'ARCH' : 'ACTIVE'}:刷新挂了` }
          : archivedOnly ? [] : [CONV]
    }))
    const { result } = run()
    await waitFor(() => expect(result.current.conversations).toEqual([CONV]))
    failing = true
    await act(async () => { await result.current.reloadConversations() })
    await waitFor(() => expect(result.current.conversationsUnread).toEqual({ error: 'CONV_ACTIVE:刷新挂了' }))
    expect(result.current.archivedUnread).toEqual({ error: 'CONV_ARCH:刷新挂了' })
    expect(result.current.conversations, '保持上一份，不是清空、更不是换成失败对象').toEqual([CONV])
    expect(result.current.conversationId, '刷新失败不该把当前选中会话也踢掉').toBe('c1')

    failing = false
    await act(async () => { await result.current.reloadConversations() })
    await waitFor(() => expect(result.current.conversationsUnread).toBeNull())
    expect(result.current.archivedUnread).toBeNull()
  })

  it('reject 面（Promise 被拒）⇒ 两句都用抛出来的原文', async () => {
    stubPocketai(chatStubs({ listConversations: () => Promise.reject(new Error('会话通道炸了')) }))
    const { result } = run()
    await waitFor(() => expect(result.current.conversationsUnread).toEqual({ error: '会话通道炸了' }))
    expect(result.current.archivedUnread).toEqual({ error: '会话通道炸了' })
  })
})

// ───────── ③ 接线计数：旧形状归零 ─────────

describe('③ 接线计数', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n')
  const CHAT = read('src/renderer/src/modules/agent/hooks/useAgentChat.ts')
  const MCP = read('src/renderer/src/modules/agent/mcp/McpPanel.tsx')
  const RAIL = read('src/renderer/src/modules/agent/components/SessionRail.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('两处"拿到就写进 state"的相邻两行必须归零（那正是探针撞到的形状）', () => {
    expect(count(CHAT, /setConversations\(list\)\n\s*setArchivedConversations\(archived\)/g), '会话两发不许再挨着裸写').toBe(0)
    expect(count(MCP, /setRecords\(recs\)\n\s*setRuntimes\(runs\)/g), 'MCP 两发不许再挨着裸写').toBe(0)
  })

  it('新落点数得出：两半各判一次、各清一次位', () => {
    expect(count(CHAT, /if \(hasIpcFailed\(list\) \|\| !Array\.isArray\(list\)\)/g), '活跃那半（切换＋刷新两处）').toBe(2)
    expect(count(CHAT, /if \(hasIpcFailed\(archived\) \|\| !Array\.isArray\(archived\)\)/g)).toBe(2)
    expect(count(CHAT, /setConversationsUnread\(null\)/g), '成功即收回，两处都要').toBeGreaterThanOrEqual(3)
    expect(count(MCP, /if \(hasIpcFailed\(recs\) \|\| !Array\.isArray\(recs\)\)/g)).toBe(1)
    expect(count(MCP, /if \(hasIpcFailed\(runs\) \|\| !Array\.isArray\(runs\)\)/g)).toBe(1)
    expect(count(MCP, /setRecords\(recs\)/g), '成功支没被顺手删').toBe(1)
    expect(count(MCP, /setRuntimes\(runs\)/g)).toBe(1)
  })

  it('会话栏那两句：空态让位，且各点各的名', () => {
    expect(count(RAIL, /<LoadFailNotice what=\{t\('agent\.sessionsList'\)}/g)).toBe(1)
    expect(count(RAIL, /<LoadFailNotice what=\{t\('agent\.archivedList'\)}/g)).toBe(1)
    expect(count(RAIL, /!conversationsUnread && conversations\.length === 0/g), '「还没有会话」要让位给那句').toBe(1)
    expect(count(RAIL, /!archivedUnread && !!archivedConversations\?\.length/g), '归档区也是').toBe(1)
  })
})
