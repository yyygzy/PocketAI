// 切换会话时迟到响应不许画进当前屏（V4-Iter-309，Agent 面行为用例）
//
// 缺陷：useAgentChat 的会话切换 effect 里，`listMessages(conversationId)` 回来就无条件
// `dispatch({type:'load'})`。切 A→B 后 A 的那一发才回来 ⇒ A 的消息整棵替换掉 B 的屏
// （卡片是会话级 state，这正是本文件自己防的"凭空多出/丢失消息"那一族）。
//
// 判据不是新发明的——本文件其余四发迟到响应全都有同一句守卫：
//   loadRunStats（:775 成功支／:782 失败支）、loadSessionStats（:792／:799）、loadSubSessionReads（:682／:697）
//   ⇒ `if (conversationIdRef.current !== id) return`。
// 只有"消息清单"这一发（用户载荷最重的那一发）漏了。§264 也已在 ChatModule 立过同一条规矩。
//
// 为什么跑真 hook 不抽纯函数：要证的正是"接线有没有把这一发挡在 dispatch 之前"，
// 抽出来就成了把接线搬进用例里（见 agent-event-attribution 顶部注释、feedback-real-sdk-boundary-tests）。
// 时序靠"每一发 listMessages 的 resolve 都握在用例手里"来定，不靠 sleep。
//
// 为什么按 **队列** 存 resolve：切一次会话会打出**两发**同名 `listMessages`——
// 会话切换 effect（:823）之外还有 `applyLastModelOf`（:464）拿它回填 provider/模型。
// 只按会话 id 存一个槽位的话，后到的那发把前一发的 resolve 顶掉 ⇒ 我要放行的那发永远不发，
// "迟到响应画进当前屏"演不出来、用例假绿（本批变异轮就是这么抓到第一版用例的）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { stubPocketai, HookProviders } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type { AssistantRecord, ConversationRecord, MessageRecord, ProviderRecord } from '../src/shared/types'

const A = 'conv-A'
const B = 'conv-B'
const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const rec = (id: string): ConversationRecord =>
  ({ id, assistantId: 'a1', title: id, modelLabel: null }) as unknown as ConversationRecord

/** 该会话 outstanding 的 listMessages 请求（同一会话可能同时挂着两发，见顶部注释） */
let pending: Record<string, Array<(rows: MessageRecord[]) => void>>

/** 照 `MessageRecord` 的真实形状给载荷（`toAgentMessages` 读 attachments／sources） */
const rowsFor = (id: string): MessageRecord[] => [
  {
    id: `msg-of-${id}`,
    conversationId: id,
    role: 'user',
    content: `来自 ${id}`,
    provider: null,
    model: null,
    status: 'done',
    parentId: null,
    createdAt: 0,
    attachments: []
  }
]

/** 放行该会话**所有**在飞请求（真实 DB 不会只答其中一发） */
const answer = (id: string): void => {
  const queue = pending[id] ?? []
  pending[id] = []
  queue.forEach((resolve) => resolve(rowsFor(id)))
}

beforeEach(() => {
  pending = {}
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: {} }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [rec(A), rec(B)],
    listMessages: (id: string) =>
      new Promise<MessageRecord[]>((resolve) => {
        ;(pending[id] ??= []).push(resolve)
      }),
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: () => null,
    listChildConversations: () => [],
    setModelContextWindow: () => ({ windows: {} }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  })
})

const idsOf = (result: { current: ReturnType<typeof useAgentChat> }): string[] =>
  result.current.messages.map((m) => m.id)

/**
 * 让 promise 链走完再断言：`act(async …)` 只刷一层微任务，而 `.then(v => dispatch)` 之后
 * 还要再排一次才落到 React。少这一步，"迟到响应画进当前屏"会在断言之后才发生 ⇒ 用例假绿。
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('§309 切会话时迟到的 listMessages 不许写进当前屏（Agent 面）', () => {
  it('A 的请求晚于切到 B ⇒ B 的屏只留 B，A 一行都不许出现', async () => {
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBeTruthy())

    // 切到 A：A 的在飞请求一条都不放行
    act(() => result.current.selectConversation(A))
    await waitFor(() => expect(pending[A]?.length).toBeTruthy())

    // 切到 B：B 的先回来 ⇒ 屏上应是 B 的消息（存在性对照：正常路径没被守卫一起挡死）
    act(() => result.current.selectConversation(B))
    await waitFor(() => expect(pending[B]?.length).toBeTruthy())
    await act(async () => {
      answer(B)
      await settle()
    })
    await waitFor(() => expect(idsOf(result)).toContain(`msg-of-${B}`))
    expect(idsOf(result)).not.toContain(`msg-of-${A}`)

    // 现在才让 A 的迟到响应落地——修前这一发会整棵替换成 A 的消息（无守卫版实测：屏上只剩 A）
    await act(async () => {
      answer(A)
      await settle()
    })
    expect(idsOf(result), '迟到的 A 不许画进 B 的屏').not.toContain(`msg-of-${A}`)
    expect(idsOf(result), 'B 自己的内容也不许被顺手清掉').toContain(`msg-of-${B}`)
  })

  it('正向对照：当前会话自己那一发正常回来时必须画出来（守"把守卫写成永远拒绝"的过度修复）', async () => {
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBeTruthy())

    act(() => result.current.selectConversation(B))
    await waitFor(() => expect(pending[B]?.length).toBeTruthy())
    await act(async () => {
      answer(B)
      await settle()
    })
    await waitFor(() => expect(idsOf(result)).toEqual([`msg-of-${B}`]))
  })
})
