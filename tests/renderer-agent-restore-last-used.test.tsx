// 「再次点开 Agent 模块 → 自动回到上次用的助手与会话」（V4-Iter-109）
//
// 测 hook 而不是整个 AgentPanel：恢复/写回落点都在 useAgentChat，
// 而 AgentPanel 挂载要拉工具配置、附件、休眠豁免等一堆无关桩。
//
// 两条容易写错的口径在这里钉死：
// ① getUiPrefs / setUiPrefs 走 **{ok,data} 信封**（不是裸记录），读要 unwrap、写失败不能用 isIpcFail；
// ② 存档只在"真正确定选中项"之后写，加载中间态（有助手还没定会话）一次都不写，
//    否则每次进模块都会把上次的存档抹成空。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { stubPocketai, pocketaiCalls, HookProviders } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type {
  AssistantRecord,
  ConversationRecord,
  ProviderRecord
} from '../src/shared/types'

const PROVIDERS = [
  { id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models: ['gpt-mini', 'gpt-max'] }
] as unknown as ProviderRecord[]

const assistant = (id: string): AssistantRecord =>
  ({ id, name: id, isBuiltin: false, isPinned: false, defaultProviderId: null, defaultModel: null }) as unknown as AssistantRecord

const conv = (id: string, assistantId = 'a1', modelLabel: string | null = 'p1:gpt-mini'): ConversationRecord =>
  ({
    id,
    assistantId,
    title: `会话 ${id}`,
    modelLabel,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    titleDefault: false
  })

interface MountOpts {
  stored?: { agentAssistantId?: string; agentConversationId?: string } | null
  prefsFail?: boolean
  /** 会话列表按助手区分：listConversations(assistantId, 活跃/归档) */
  conversations?: Record<string, ConversationRecord[]>
  archived?: Record<string, ConversationRecord[]>
  assistants?: AssistantRecord[]
}

function mount(opts: MountOpts = {}) {
  const stored = opts.stored ?? null
  stubPocketai({
    getUiPrefs: () =>
      opts.prefsFail ? { ok: false, error: '库读不到' } : { ok: true, data: { ...stored } },
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: (assistantId: string, _agent: boolean, isArchived: boolean) =>
      (isArchived ? opts.archived?.[assistantId] : opts.conversations?.[assistantId]) ?? [],
    getAgentTextProtocol: () => [],
    // §234：模型栏那颗「上下文窗口」挂载要读这张表（桩给空表=没有一台设过）
    getModelContextWindows: () => ({}),
    // §237：挂载时要读这张备用表（桩给空表＝没有一台设过备用）
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: () => null,
    listChildConversations: () => [],
    setModelContextWindow: () => ({ windows: {} }),
    setAgentTextProtocol: () => [],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  })
  const { result } = renderHook(() => useAgentChat(PROVIDERS, opts.assistants ?? [assistant('a1')]), {
    wrapper: HookProviders
  })
  return result
}

/** 等会话列表这一轮 IPC 真正跑完（列表为空时没有状态变化可等，只能等调用本身） */
async function flushListRead(): Promise<void> {
  await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'listConversations')).toBe(true))
  await act(async () => {
    await Promise.resolve()
  })
}

function prefsWrites(): Array<Record<string, unknown>> {
  return pocketaiCalls()
    .filter((c) => c.fn === 'setUiPrefs')
    .map((c) => c.args[0] as Record<string, unknown>)
}

/** 等存档读取这一轮 IPC 真正跑完（读到空 / 读失败都要能观察到后果） */
async function flushPrefsRead(): Promise<void> {
  await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'getUiPrefs')).toBe(true))
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => localStorage.clear())

describe('Agent 模块记住上次用的助手与会话', () => {
  it('存档命中：助手、会话、该会话上次用的模型一起回来，内容按该会话加载', async () => {
    const result = mount({
      stored: { agentAssistantId: 'a1', agentConversationId: 'c2' },
      conversations: { a1: [conv('c1', 'a1', 'p1:gpt-max'), conv('c2')] }
    })
    await waitFor(() => expect(result.current.conversationId).toBe('c2'))
    expect(result.current.assistantId).toBe('a1')
    expect(result.current.model).toBe('gpt-mini')
    // 会话内容确实按 c2 拉过（不是只改了个 id）
    expect(pocketaiCalls().some((c) => c.fn === 'listMessages' && c.args[0] === 'c2')).toBe(true)
  })

  it('存档里的会话已被删除：回落到最近一次会话，而不是停在空选中', async () => {
    const result = mount({
      stored: { agentAssistantId: 'a1', agentConversationId: 'gone' },
      conversations: { a1: [conv('c1', 'a1', 'p1:gpt-max')] }
    })
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    expect(result.current.model).toBe('gpt-max')
  })

  it('存档里的助手已被删除：清回未选中，并把存档一起抹掉', async () => {
    const result = mount({
      stored: { agentAssistantId: 'ghost', agentConversationId: 'c9' },
      conversations: { a1: [conv('c1')] },
      assistants: [assistant('a1')]
    })
    // §362：见证要选"清完之后才成立"的那一组，不能是「prefs 被写过」（挂载本身就可能写一次）。
    // 改前等 prefsWrites().length>0 就同步读 hook state，满载时那一发还没 settle⇒读到 'ghost'（负载窗里红的那条）。
    await waitFor(() => {
      expect(result.current.assistantId).toBe('')
      expect(result.current.conversationId).toBeNull()
      expect(prefsWrites()).toEqual([{ agentAssistantId: '', agentConversationId: '' }])
    })
  })

  it('无存档（对照）：不自动选助手，也不写库；用户选了助手与会话后才落档', async () => {
    const result = mount({
      stored: null,
      conversations: { a1: [conv('c1'), conv('c2')] }
    })
    await flushPrefsRead()
    expect(result.current.assistantId).toBe('')
    expect(prefsWrites()).toEqual([])
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    await waitFor(() => expect(prefsWrites()).toEqual([{ agentAssistantId: 'a1', agentConversationId: 'c1' }]))
  })

  it('新助手还没有会话：中间态一次都不写，免得把上次存档抹空', async () => {
    const result = mount({ stored: null, conversations: {} })
    await flushPrefsRead()
    act(() => result.current.setAssistantId('a1'))
    await flushListRead()
    expect(result.current.conversationId).toBeNull()
    expect(prefsWrites()).toEqual([])
  })

  it('恢复来的会话属于另一个助手时，切助手不会把旧会话 id 套到新助手上', async () => {
    const result = mount({
      stored: { agentAssistantId: 'a1', agentConversationId: 'c2' },
      conversations: { a1: [conv('c1'), conv('c2')], a2: [conv('d1', 'a2')] },
      assistants: [assistant('a1'), assistant('a2')]
    })
    await waitFor(() => expect(result.current.conversationId).toBe('c2'))
    act(() => result.current.setAssistantId('a2'))
    await waitFor(() => expect(result.current.conversationId).toBe('d1'))
  })

  it('偏好通道失败：不恢复也不写库，模块照常可用（空态）', async () => {
    const result = mount({
      prefsFail: true,
      conversations: { a1: [conv('c1')] }
    })
    await flushPrefsRead()
    expect(result.current.assistantId).toBe('')
    expect(result.current.conversationId).toBeNull()
    expect(prefsWrites()).toEqual([])
  })
})
