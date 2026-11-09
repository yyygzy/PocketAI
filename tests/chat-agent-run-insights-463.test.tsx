// @vitest-environment jsdom
// P5 批次 1：`useAgentRunInsights` 从 `agent/hooks` 搬到 `chat/` 后的行为用例。
//
// 为什么这枚用例落在对话壳入口：搬家的验收口径是「每个搬走的 hook 至少有一条行为用例打在新入口」。
// 既有用例里没有直接挂这个 hook 的（`chat-session-stats-461` 是拿 ChatView 的 props 演的），
// 所以这里从新路径 import，把三条契约钉住：
//   · 未启用时两发都不打（普通会话打开不该有 `agent:list-runs`／`get-session-stats`）；
//   · 启用时读回 run 索引与会话累计，并把 run 映射到对应轮次；
//   · 读不到时给"读不到"的文案而不是留旧数，重试能重发会话累计那一发。
import { describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { AgentRunIndexEntry, AgentSessionStats, MessageRecord } from '../src/shared/types'
import { useAgentRunInsights } from '../src/renderer/src/modules/chat/useAgentRunInsights'
import { HookProviders, calledFns, stubPocketai } from './helpers/renderer'

const msg = (id: string, role: MessageRecord['role'], createdAt: number): MessageRecord => ({
  id,
  conversationId: 'c1',
  role,
  content: id,
  provider: null,
  model: null,
  status: 'done',
  parentId: null,
  createdAt
})

const run = (messageIds: string[], startedAt: number, endedAt: number): AgentRunIndexEntry => ({
  requestId: 'r1',
  conversationId: 'c1',
  startedAt,
  endedAt,
  stepCount: 2,
  totalDurationMs: 500,
  totalTokens: 700,
  errorSteps: 0,
  messageIds
})

const stats: AgentSessionStats = {
  runCount: 1,
  totalDurationMs: 500,
  totalTokens: 700,
  totalSteps: 2
}

describe('useAgentRunInsights（chat/ 新入口）', () => {
  it('未启用时一发都不打，结果停在空态', () => {
    stubPocketai({})
    const { result } = renderHook(
      () => useAgentRunInsights({ conversationId: 'c1', enabled: false, messages: [] }),
      { wrapper: HookProviders }
    )
    expect(result.current.runs).toEqual([])
    expect(result.current.sessionStats).toBeNull()
    expect(calledFns()).not.toContain('listAgentRuns')
    expect(calledFns()).not.toContain('getSessionStats')
  })

  it('启用后读回 run 索引与会话累计，并把 run 映射到对应轮次', async () => {
    const runs = [run(['m2'], 1000, 2000)]
    stubPocketai({
      listAgentRuns: () => runs,
      getSessionStats: () => stats
    })
    const { result } = renderHook(
      () =>
        useAgentRunInsights({
          conversationId: 'c1',
          enabled: true,
          messages: [msg('m1', 'user', 900), msg('m2', 'assistant', 1500)]
        }),
      { wrapper: HookProviders }
    )
    await waitFor(() => {
      expect(result.current.runs).toEqual(runs)
      expect(result.current.sessionStats).toEqual(stats)
    })
    // messageIds 命中优先：这一轮的 key 是首条 user 消息的 id
    expect(result.current.runsByTurn.get('m1')).toEqual(runs[0])
    expect(calledFns()).toContain('listAgentRuns')
    expect(calledFns()).toContain('getSessionStats')
  })

  it('两发都读不到时给出文案，而不是拿上一次的数字说话', async () => {
    stubPocketai({
      listAgentRuns: () => ({ ok: false, error: 'boom' }),
      getSessionStats: () => ({ ok: false, error: 'boom' })
    })
    const { result } = renderHook(
      () => useAgentRunInsights({ conversationId: 'c1', enabled: true, messages: [] }),
      { wrapper: HookProviders }
    )
    await waitFor(() => {
      expect(result.current.unread).toBe('boom')
      expect(result.current.sessionUnread).toBe('boom')
    })
    expect(result.current.runs).toEqual([])
    expect(result.current.sessionStats).toBeNull()
  })

  it('retrySessionStats 重发会话累计，成功后文案退场', async () => {
    let calls = 0
    stubPocketai({
      listAgentRuns: () => [],
      getSessionStats: () => {
        calls += 1
        return calls === 1 ? { ok: false, error: 'boom' } : stats
      }
    })
    const { result } = renderHook(
      () => useAgentRunInsights({ conversationId: 'c1', enabled: true, messages: [] }),
      { wrapper: HookProviders }
    )
    await waitFor(() => expect(result.current.sessionUnread).toBe('boom'))
    act(() => result.current.retrySessionStats())
    await waitFor(() => expect(result.current.sessionStats).toEqual(stats))
    expect(result.current.sessionUnread).toBeNull()
  })
})
