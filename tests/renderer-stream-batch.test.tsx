// PERF-02：useStreamSession 流式 chunk rAF 合批
//
// 断言口径（手动接管 rAF，不依赖真实帧时钟，规避 flaky）：
//  · 连续多次 onChatChunk / onAgentChunk → 状态在 flush 前不动，手动 flush 一帧后合并追加；
//  · done / agent done 到达时残余缓冲被同步 flush（不丢最后一截文本）；
//  · requestId 不匹配的 chunk 不入缓冲；新一轮 beginStream 清掉残余缓冲（防跨请求串字）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { useStreamSession } from '../src/renderer/src/modules/chat/useStreamSession'
import type { ChatChunkEvent, ChatDoneEvent, ChatErrorEvent } from '../src/shared/types'
import type { AgentChunkEvent, AgentDoneEvent, AgentErrorEvent, AgentStepEvent } from '../src/shared/types'

// ---- 手动 rAF：push 进队列，测试里显式 flushFrames 触发 ----
let frameId = 0
const pendingFrames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  frameId = 0
  pendingFrames.clear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pendingFrames.set(++frameId, cb)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 触发当前排队的所有帧（每帧一次 React 提交） */
function flushFrames(): void {
  const cur = [...pendingFrames.values()]
  pendingFrames.clear()
  act(() => {
    for (const cb of cur) cb(performance.now())
  })
}

// ---- 事件订阅桩：抓住各通道的 handler，用例里手动派发事件 ----
type Handler = (e: never) => void
const subs: Record<string, Handler[]> = {}
const capture =
  (name: string) =>
  (h: Handler): (() => void) => {
    ;(subs[name] ??= []).push(h)
    return () => {}
  }

const emit = (name: string, e: unknown): void => {
  const list = subs[name]
  expect(list?.length, `通道 ${name} 应已订阅`).toBeTruthy()
  for (const h of list!) h(e as never)
}

function mountHook() {
  stubPocketai({
    onChatChunk: capture('chatChunk'),
    onChatDone: capture('chatDone'),
    onChatError: capture('chatError'),
    onAgentStep: capture('agentStep'),
    onAgentChunk: capture('agentChunk'),
    onAgentDone: capture('agentDone'),
    onAgentError: capture('agentError')
  })
  return renderHook(
    () =>
      useStreamSession({
        loadMessages: () => {},
        reloadConversations: () => {},
        getCurrentConvId: () => 'c1'
      }),
    { wrapper: HookProviders }
  )
}

const TARGETS = [
  { providerId: 'p1', model: 'm1' },
  { providerId: 'p1', model: 'm2' }
]

describe('PERF-02 — 聊天列 chunk rAF 合批', () => {
  it('连续多次 chunk → flush 一帧合并追加（每帧一次提交，不逐 token）', () => {
    const r = mountHook()
    let id = ''
    act(() => {
      id = r.result.current.beginStream('c1', TARGETS)!
    })
    expect(id).not.toBe('')

    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'A' } as ChatChunkEvent)
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'B' } as ChatChunkEvent)
      emit('chatChunk', { requestId: id, targetIndex: 1, messageId: 'y', delta: 'C' } as ChatChunkEvent)
    })
    // flush 前：delta 只在缓冲里，屏上没有
    expect(r.result.current.liveColumns![0]!.content).toBe('')
    expect(r.result.current.liveColumns![1]!.content).toBe('')

    flushFrames()
    expect(r.result.current.liveColumns![0]!.content).toBe('AB')
    expect(r.result.current.liveColumns![1]!.content).toBe('C')
  })

  it('done 到达时残余缓冲被同步 flush（不丢最后一截文本）', () => {
    const r = mountHook()
    let id = ''
    act(() => {
      id = r.result.current.beginStream('c1', TARGETS)!
    })
    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'A' } as ChatChunkEvent)
    })
    flushFrames()
    // 这一段没等 rAF flush 就来了 done
    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'B' } as ChatChunkEvent)
      emit('chatDone', { requestId: id, targetIndex: 0, status: 'done' } as ChatDoneEvent)
    })
    expect(r.result.current.liveColumns![0]!.content).toBe('AB')
    expect(r.result.current.liveColumns![0]!.status).toBe('done')
  })

  it('error 到达时残余缓冲同样被 flush', () => {
    const r = mountHook()
    let id = ''
    act(() => {
      id = r.result.current.beginStream('c1', TARGETS)!
    })
    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'A' } as ChatChunkEvent)
      emit('chatError', { requestId: id, targetIndex: 0, error: 'boom' } as ChatErrorEvent)
    })
    expect(r.result.current.liveColumns![0]!.content).toBe('A')
    expect(r.result.current.liveColumns![0]!.status).toBe('error')
  })

  it('requestId 不匹配的 chunk 丢弃；failStream 终结后新一轮不串入旧缓冲', () => {
    const r = mountHook()
    let id = ''
    act(() => {
      id = r.result.current.beginStream('c1', TARGETS)!
    })
    act(() => {
      emit('chatChunk', { requestId: 'stale-rid', targetIndex: 0, messageId: 'x', delta: 'X' } as ChatChunkEvent)
    })
    flushFrames()
    expect(r.result.current.liveColumns![0]!.content, '旧请求的 chunk 不入缓冲').toBe('')

    // 当前请求的残余缓冲还没 flush，本轮就 IPC reject 终结（failStream 清缓冲），随后起新一轮
    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'OLD' } as ChatChunkEvent)
    })
    act(() => {
      r.result.current.failStream(id, 'c1')
    })
    let id2 = ''
    act(() => {
      id2 = r.result.current.beginStream('c1', TARGETS)!
    })
    expect(id2).not.toBe('')
    // 新一轮里来的旧 rid chunk 不许落字
    act(() => {
      emit('chatChunk', { requestId: id, targetIndex: 0, messageId: 'x', delta: 'X' } as ChatChunkEvent)
    })
    flushFrames()
    expect(
      r.result.current.liveColumns![0]!.content,
      '旧请求的残余缓冲/旧 rid chunk 都不能串进新列'
    ).toBe('')
  })
})

describe('PERF-02 — agent chunk rAF 合批', () => {
  /** 起 agent 流并建一张 assistant 占位卡（thought 步），返回 requestId */
  function startAgent(r: ReturnType<typeof mountHook>): string {
    let id = ''
    act(() => {
      id = r.result.current.beginAgentStream('c1')!
    })
    expect(id).not.toBe('')
    act(() => {
      emit('agentStep', {
        requestId: id,
        conversationId: 'c1',
        stepIndex: 0,
        type: 'thought',
        messageId: 'm1',
        text: ''
      } as AgentStepEvent)
    })
    return id
  }

  it('连续多次 chunk → flush 一帧合并追加（正文与 reasoning 分流）', () => {
    const r = mountHook()
    const id = startAgent(r)
    const chunk = (delta: string, reasoning?: boolean): void => {
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta, reasoning } as AgentChunkEvent)
    }
    act(() => {
      chunk('he')
      chunk('llo')
      chunk('思考', true)
    })
    expect(r.result.current.agentStream!.messages[0]!.text).toBe('')
    expect(r.result.current.agentStream!.messages[0]!.reasoning).toBeUndefined()

    flushFrames()
    expect(r.result.current.agentStream!.messages[0]!.text).toBe('hello')
    expect(r.result.current.agentStream!.messages[0]!.reasoning).toBe('思考')
  })

  it('agent done 到达时残余缓冲被同步 flush', () => {
    const r = mountHook()
    const id = startAgent(r)
    act(() => {
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta: 'hello' } as AgentChunkEvent)
    })
    flushFrames()
    act(() => {
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta: '!' } as AgentChunkEvent)
      emit('agentDone', { requestId: id, conversationId: 'c1' } as AgentDoneEvent)
    })
    expect(r.result.current.agentStream!.messages[0]!.text).toBe('hello!')
  })

  it('agent error 到达时残余缓冲被 flush，错误卡不吞正文', () => {
    const r = mountHook()
    const id = startAgent(r)
    act(() => {
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta: 'abc' } as AgentChunkEvent)
      emit('agentError', { requestId: id, conversationId: 'c1', error: 'boom' } as AgentErrorEvent)
    })
    expect(r.result.current.agentStream!.messages[0]!.text).toBe('abc')
    expect(r.result.current.agentStream!.messages.some((m) => m.isError)).toBe(true)
  })

  it('新一轮 agent 流里：旧 rid 的残余 chunk 不串进新卡片', () => {
    const r = mountHook()
    const id = startAgent(r)
    act(() => {
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta: 'OLD' } as AgentChunkEvent)
    })
    // 本轮经 failStream 终结（清缓冲），再起新一轮；旧 rid 的 chunk 迟到也不许落字
    act(() => {
      r.result.current.failStream(id, 'c1')
    })
    let id2 = ''
    act(() => {
      id2 = r.result.current.beginAgentStream('c1')!
    })
    act(() => {
      emit('agentStep', {
        requestId: id2,
        conversationId: 'c1',
        stepIndex: 0,
        type: 'thought',
        messageId: 'm1',
        text: ''
      } as AgentStepEvent)
      emit('agentChunk', { requestId: id, conversationId: 'c1', stepIndex: 0, messageId: 'm1', delta: 'X' } as AgentChunkEvent)
    })
    flushFrames()
    expect(r.result.current.agentStream!.messages[0]!.text).toBe('')
  })
})
