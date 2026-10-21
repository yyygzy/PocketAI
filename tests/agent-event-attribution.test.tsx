// Agent 事件归属：谁的事件才写谁的状态（V4-Iter-148 的前置缺陷修复 / B84）
//
// 修之前 `onAgentChunk` **完全没有归属判断**，而卡片寻址用的是 `messageId`：
// 中止后立刻重发，上一轮的迟到 token 会找到那张**已经定稿的旧卡**（旧卡还在 messages 里）
// 并把文字接上去——用户看到的是一句回答在自己眼皮底下又长了一段。
// 同一次改动把 step 事件补上会话归属：运行中切到别的会话时，上一轮的 tool 卡会被
// append 进**当前看着的**那条会话，而这些卡没有 DB 记录，切走再切回就"凭空消失"。
//
// 为什么这里跑真 hook 而不是抽个纯函数出来测：判据读的是两个 ref，抽出来就成了
// `acceptsEvent(ev, requestId, conversationId)` 这种"把接线搬到用例里"的形状
// （见 feedback-real-sdk-boundary-tests）——接线本身正是要证的那一段。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { stubPocketai, pocketaiCalls, HookProviders } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type {
  AgentChunkEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentStepEvent,
  AssistantRecord,
  ConversationRecord,
  ProviderRecord
} from '../src/shared/types'

const CONV = 'c1'
const OTHER = 'c2'
const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const CONV_RECORD = { id: CONV, assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord

const h = {
  step: [] as Array<(e: AgentStepEvent) => void>,
  chunk: [] as Array<(e: AgentChunkEvent) => void>,
  done: [] as Array<(e: AgentDoneEvent) => void>,
  error: [] as Array<(e: AgentErrorEvent) => void>
}

function clearHandlers(): void {
  // 原地清空：`sub(h.step)` 在 beforeEach 里捕获的是**数组引用**，重新赋值会让老闭包继续往旧数组推
  h.step.length = 0
  h.chunk.length = 0
  h.done.length = 0
  h.error.length = 0
}

/** 把订阅通道包成"记下处理函数"，用例就能按主进程那个形状把事件喂进来 */
function sub<T>(bucket: Array<(e: T) => void>): (...args: unknown[]) => () => void {
  return (...args: unknown[]) => {
    const handler = args[0] as (e: T) => void
    bucket.push(handler)
    return () => {
      const i = bucket.indexOf(handler)
      if (i >= 0) bucket.splice(i, 1)
    }
  }
}

function textOf(result: { current: ReturnType<typeof useAgentChat> }, id: string): string | undefined {
  return result.current.messages.find((m) => m.id === id)?.text
}

async function mountRunning(): Promise<{
  result: { current: ReturnType<typeof useAgentChat> }
  requestId: () => string
}> {
  const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), {
    wrapper: HookProviders
  })
  act(() => result.current.setAssistantId('a1'))
  await waitFor(() => expect(result.current.conversationId).toBe(CONV))
  act(() => result.current.changeProvider('p1'))
  act(() => result.current.setModel('m1'))
  await act(async () => {
    void result.current.send('做一件事', [])
  })
  const requestId = (): string => {
    const sent = pocketaiCalls().filter((c) => c.fn === 'sendMessage')
    return (sent[sent.length - 1]!.args[0] as { requestId: string }).requestId
  }
  return { result, requestId }
}

/** 造一张已定稿的 assistant 卡（走真 step 事件，不是直接塞 messages） */
function seedCard(result: { current: ReturnType<typeof useAgentChat> }, requestId: string, id: string, text: string): void {
  act(() => {
    h.step[0]!({ requestId, conversationId: CONV, stepIndex: 1, type: 'thought', text, messageId: id })
  })
  expect(textOf(result, id)).toBe(text)
}

beforeEach(() => {
  clearHandlers()
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: {} }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [CONV_RECORD],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getAgentTextProtocol: () => [],
    // §234：模型栏那颗「上下文窗口」挂载要读这张表（桩给空表=没有一台设过）
    getModelContextWindows: () => ({}),
    // §237：挂载时要读这张备用表（桩给空表＝没有一台设过备用）
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: () => null,
    listChildConversations: () => [],
    setModelContextWindow: () => ({ windows: {} }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    onAgentStep: sub(h.step),
    onAgentChunk: sub(h.chunk),
    onAgentDone: sub(h.done),
    onAgentError: sub(h.error),
    onConversationTitle: () => () => {}
  })
})

const chunk = (requestId: string, messageId: string, delta: string, conversationId = CONV): void => {
  act(() => {
    h.chunk[0]!({ requestId, conversationId, stepIndex: 1, messageId, delta })
  })
}

describe('chunk 的归属（本批修的那条真缺陷）', () => {
  it('当前这轮的 chunk 写进卡（存在性对照：过滤没把正常路径一起挡掉）', async () => {
    const { result, requestId } = await mountRunning()
    seedCard(result, requestId(), 'am1', '起点')
    chunk(requestId(), 'am1', 'ABC')
    expect(textOf(result, 'am1')).toBe('起点ABC')
  })

  it('别的 requestId 一个字节都不写', async () => {
    const { result, requestId } = await mountRunning()
    seedCard(result, requestId(), 'am1', '起点')
    chunk('agent_另一个请求', 'am1', '不该出现')
    expect(textOf(result, 'am1')).toBe('起点')
  })

  it('中止后立刻重发：上一轮的迟到 token 不再长在已经定稿的旧卡上', async () => {
    const { result, requestId } = await mountRunning()
    const first = requestId()
    seedCard(result, first, 'am1', '第一轮')
    await act(async () => {
      result.current.abort()
    })
    await act(async () => {
      void result.current.send('第二轮', [])
    })
    expect(requestId(), '两轮必须换了 requestId，否则这条用例是空的').not.toBe(first)
    expect(result.current.running).toBe(true)
    chunk(first, 'am1', '串台的文字')
    expect(textOf(result, 'am1')).toBe('第一轮')
    // 新轮的 chunk 照常生效（不是"把整条流关掉"）
    chunk(requestId(), 'am1', '正常')
    expect(textOf(result, 'am1')).toBe('第一轮正常')
  })
})

describe('step 的会话归属：运行中切走，上一轮的卡不许插进当前会话', () => {
  it('requestId 对但 conversationId 不是看着的那条 ⇒ 消息流与 chip 流都不动', async () => {
    const { result, requestId } = await mountRunning()
    const before = result.current.messages.length
    act(() => {
      h.step[0]!({
        requestId: requestId(),
        conversationId: OTHER,
        stepIndex: 2,
        type: 'tool_call',
        toolCall: { id: 'tc9', type: 'function', function: { name: 'time_now', arguments: '{}' } }
      })
    })
    expect(result.current.messages).toHaveLength(before)
    expect(result.current.liveSteps).toHaveLength(0)
    expect(result.current.currentStep).toBe(0)
  })

  it('同一条会话的当前轮照常进（反向对照）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.step[0]!({
        requestId: requestId(),
        conversationId: CONV,
        stepIndex: 2,
        type: 'tool_call',
        toolCall: { id: 'tc9', type: 'function', function: { name: 'time_now', arguments: '{}' } }
      })
    })
    expect(result.current.messages).toHaveLength(2)
    expect(result.current.liveSteps).toHaveLength(1)
    expect(result.current.currentStep).toBe(2)
  })
})

describe('DONE / ERROR：总闸按 requestId，会话级的展示按 conversationId', () => {
  it('旧一轮的迟到 DONE 不解开 running、不清 chip', async () => {
    const { result, requestId } = await mountRunning()
    const first = requestId()
    act(() => {
      h.step[0]!({ requestId: first, conversationId: CONV, stepIndex: 4, type: 'thought', text: '旧轮的思考' })
    })
    // 上一轮遗留的 DONE 现在才到（新轮正在跑）
    act(() => {
      h.done[0]!({ requestId: 'agent_另一个请求', conversationId: CONV, finalMessageId: 'x', fullContent: '', stepCount: 1 })
    })
    expect(result.current.running).toBe(true)
    expect(result.current.currentStep, '迟到 DONE 不该把正在跑的步数清零').toBe(4)
    expect(result.current.liveSteps, '迟到 DONE 不该清空 chip 条').toHaveLength(1)
  })

  it('当前轮的 DONE：会话说得清才落统计，但 running 一定解掉（切走了也不能冻住输入框）', async () => {
    const { result, requestId } = await mountRunning()
    seedCard(result, requestId(), 'am1', '起点')
    // 用户切到另一条会话（列表桩只有 c1，这里直接看 conversationId 不匹配的分支）
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: OTHER,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 3,
        traceStats: { totalDurationMs: 1, totalTokens: 2, stepCount: 3 }
      })
    })
    expect(result.current.running).toBe(false)
    expect(result.current.runStats, '迟到 DONE 的统计不该盖到当前会话上').toBeNull()
  })

  it('当前轮、当前会话的 DONE：统计与复位一起生效', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: CONV,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 3,
        usedTools: true,
        traceStats: { totalDurationMs: 1200, totalTokens: 30, stepCount: 3 }
      })
    })
    expect(result.current.running).toBe(false)
    expect(result.current.runStats?.stepCount).toBe(3)
    expect(result.current.noToolCallNotice).toBe(false)
  })

  it('ERROR：别的会话的失败不点亮「可断点恢复」，但 running 照样解掉', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.error[0]!({ requestId: requestId(), conversationId: OTHER, error: '炸了' })
    })
    expect(result.current.running).toBe(false)
    expect(result.current.interrupted, '中断提示是按会话讲的，不该点亮在当前会话上').toBe(false)
  })

  it('ERROR：当前轮、当前会话 ⇒ interrupted 点亮', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.error[0]!({ requestId: requestId(), conversationId: CONV, error: '炸了' })
    })
    expect(result.current.interrupted).toBe(true)
  })

  it('ERROR：旧一轮的迟到失败被丢掉（chip 与 running 都不动）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.step[0]!({ requestId: requestId(), conversationId: CONV, stepIndex: 5, type: 'thought', text: 'x' })
    })
    expect(result.current.liveSteps.length).toBe(1)
    act(() => {
      h.error[0]!({ requestId: 'agent_另一个请求', conversationId: CONV, error: '旧轮炸了' })
    })
    expect(result.current.running).toBe(true)
    expect(result.current.liveSteps.length).toBe(1)
    expect(result.current.interrupted).toBe(false)
  })
})

// V4-Iter-243：零调用提示的证据面。
// §242 真机那一趟同一台模型**上一轮调了工具、这一轮没调**，而旧判据只看本轮的
// `usedTools === false` 就弹出那句「建议换用 7b 及以上模型」——拿一轮的信号断言这台模型的行为。
// 现在要整条会话都没有工具卡才亮。两条用例互为对照：只把条件改回"看本轮"，第一条必红。
describe('零调用提示：证据是整条会话，不是这一轮', () => {
  it('本轮没调工具，但这条会话此前调过 ⇒ 不亮（"这台模型似乎从不"这句没有证据）', async () => {
    const { result, requestId } = await mountRunning()
    // 消息流里先有一张 tool 卡（走真 step 事件，不直接塞 messages）：它就是"这条会话用过工具"的证据
    act(() => {
      h.step[0]!({
        requestId: requestId(),
        conversationId: CONV,
        stepIndex: 1,
        type: 'tool_call',
        toolCall: { id: 'call-1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }
      })
    })
    expect(result.current.messages.some((m) => m.role === 'tool')).toBe(true)
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: CONV,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 2,
        usedTools: false
      })
    })
    expect(result.current.noToolCallNotice).toBe(false)
  })

  it('正向对照：整条会话都没有工具卡、本轮也没调 ⇒ 亮（条件收紧不能把它收紧成恒不亮）', async () => {
    const { result, requestId } = await mountRunning()
    expect(result.current.messages.some((m) => m.role === 'tool')).toBe(false)
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: CONV,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 1,
        usedTools: false
      })
    })
    expect(result.current.noToolCallNotice).toBe(true)
  })

  it('本轮真的调了工具 ⇒ 不亮（这一档不依赖会话证据，别和上面两条混成一条）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: CONV,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 3,
        usedTools: true
      })
    })
    expect(result.current.noToolCallNotice).toBe(false)
  })

  it('切到另一条会话后提示复位（上一轮的"没调"不该跟到新一轮）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      h.done[0]!({
        requestId: requestId(),
        conversationId: CONV,
        finalMessageId: 'x',
        fullContent: '',
        stepCount: 1,
        usedTools: false
      })
    })
    expect(result.current.noToolCallNotice).toBe(true)
    act(() => result.current.selectConversation('c9'))
    await waitFor(() => expect(result.current.conversationId).toBe('c9'))
    expect(result.current.noToolCallNotice).toBe(false)
  })
})
