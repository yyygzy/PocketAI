// V4-Iter-396（缺陷 hunt §391 候选 ⑧）：Agent 的 DONE 事件把「trace 统计读不出来」画成三个 0
//
// 病灶＝`engine.ts` 的 `safeTraceStats` 在 catch 里回 `{ totalDurationMs: 0, totalTokens: 0, stepCount: 0 }`，
// 而 DONE 事件旁边就躺着我们知道的真步数（`stepCount: ctx.stepCount`）。渲染层 `setRunStats(e.traceStats ?? null)`
// 把那份 0 当真值收下 ⇒ 屏上「0 步 · 耗时 0ms · 0 tokens」——与"这一轮确实一步没跑成"同一个形状，
// 而那一发失败其实是**账本没读到**（库被关／SQL IO 错，U 盘场景）。
//
// 修法＝三档分脸：读到⇒带 `traceStats`（哪怕是真实的 0 行账本也照原样带）；读不出来⇒**不带这一颗**，
// 渲染层于是走与挂载同一条重读路（`loadRunStats`）：重读成功就填真值、失败就亮 §264 那颗既有的
// 「本次运行统计 读不到」＋重试键。不新增句子、不新增键，把"没读到"交给已经会说话的那张脸。
//
// 本文件＝真 hook（`useAgentChat`）接住喂进来的 DONE 事件——判据是"这一发读到了没有"这条接线，
// 抽成纯函数就变成把接线搬进用例（同 `tests/agent-event-attribution.test.tsx` 的理由）。
// 面板那张脸本身（那句＋那颗重试键）由 §264 的 `tests/ipc-jump-read-264.test.tsx` 演；
// 结构纪律在 `tests/trace-stats-unread-gate-396.test.ts`。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { stubPocketai, pocketaiCalls, HookProviders } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type {
  AgentDoneEvent,
  AgentRunStats,
  AssistantRecord,
  ConversationRecord,
  ProviderRecord
} from '../src/shared/types'

const CONV = 'c1'
const OTHER = 'c2'
const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const CONV_RECORD = { id: CONV, assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord

/** 重读那发（`getLatestRunStats`）的四档到货：真值／失败信封／读到 null／抛出 */
const M = vi.hoisted(() => ({
  // 默认 'null'＝挂载那一发读到"库里没有行"（安静），各用例要演的那一档在喂 DONE 之前才切，
  // 否则"那句"会被挂载路径先点亮，判据就说不清是谁那一发了
  mode: 'null' as 'ok' | 'fail' | 'null' | 'throw',
  done: [] as Array<(e: AgentDoneEvent) => void>,
  step: [] as Array<(e: never) => void>,
  reset(): void {
    this.mode = 'null'
    this.done.length = 0
    this.step.length = 0
  }
}))

const STATS: AgentRunStats = { totalDurationMs: 1200, totalTokens: 30, stepCount: 3 }

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

beforeEach(() => {
  M.reset()
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: {} }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [CONV_RECORD],
    listMessages: () => [],
    getLatestRunStats: () => {
      if (M.mode === 'fail') return { ok: false, error: 'STATS_RUN:运行统计读不到' }
      if (M.mode === 'throw') return Promise.reject(new Error('运行统计通道炸了'))
      if (M.mode === 'null') return null
      return STATS
    },
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
    onAgentStep: sub(M.step),
    onAgentChunk: () => () => {},
    onAgentDone: sub(M.done),
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  })
})

/** 挂一轮真在跑的会话（DONE 事件要过 requestId 归属判据，没发过send就会被整条挡掉） */
async function mountRunning(): Promise<{
  result: { current: ReturnType<typeof useAgentChat> }
  requestId: () => string
}> {
  const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
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

const statsCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'getLatestRunStats').length

function feedDone(requestId: string, over: Partial<AgentDoneEvent>, conversationId = CONV): void {
  act(() => {
    M.done[0]!({
      requestId,
      conversationId,
      finalMessageId: 'x',
      fullContent: '',
      stepCount: 3,
      usedTools: true,
      ...over
    })
  })
}

describe('① 读到⇒照原样用那份（正向对照：新档不许把成功也接管）', () => {
  it('DONE 带 traceStats ⇒ 填进去、不重拉、零"读不到"', async () => {
    const { result, requestId } = await mountRunning()
    const before = statsCalls()
    feedDone(requestId(), { traceStats: { totalDurationMs: 900, totalTokens: 12, stepCount: 2 } })
    expect(result.current.runStats).toEqual({ totalDurationMs: 900, totalTokens: 12, stepCount: 2 })
    expect(result.current.runStatsUnread).toBeNull()
    expect(statsCalls(), '读到就不该再多拉一发').toBe(before)
  })

  it('反向钉：读到的账本真是 0 行（三个 0）⇒ 照摆 0，不许折成"读不到"（沉默与没读到是两件事）', async () => {
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: { totalDurationMs: 0, totalTokens: 0, stepCount: 0 } })
    expect(result.current.runStats, '现数 runStats：' + JSON.stringify(result.current.runStats)).not.toBeNull()
    expect(result.current.runStats?.stepCount).toBe(0)
    expect(result.current.runStatsUnread).toBeNull()
  })
})

describe('② 读不出来⇒事件里不带这一颗，屏上不许出现 0', () => {
  it('不带 traceStats ⇒ 先把上一轮的旧数字收掉，并走与挂载同一条重读路（多拉一发）', async () => {
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: STATS })
    expect(result.current.runStats).toEqual(STATS)
    const before = statsCalls()
    // 第二发不带＝主进程那一读失败了。在飞那一帧本身就是判据对象（§365 ① 档）：
    // 旧值必须当场收掉，而"读不到"那句此时还不该出现（重读还没回来）
    feedDone(requestId(), { traceStats: undefined })
    expect(result.current.runStats, '现数 runStats：' + JSON.stringify(result.current.runStats)).toBeNull()
    expect(result.current.runStatsUnread).toBeNull()
    await waitFor(() => expect(statsCalls()).toBe(before + 1))
  })

  it('重读也失败（resolve 的失败信封）⇒ 那颗既有的「本次运行统计 读不到」的条件成立，runStats 仍是 null', async () => {
    const { result, requestId } = await mountRunning()
    // 挂载那一发读到 null⇒安静（先证明 DONE 之前那句还没亮），再切成失败档
    await waitFor(() => expect(statsCalls()).toBeGreaterThan(0))
    expect(result.current.runStatsUnread).toBeNull()
    M.mode = 'fail'
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(result.current.runStatsUnread).not.toBeNull())
    expect(result.current.runStats, '改前形状＝0 步 0ms 0 tokens 上屏').toBeNull()
    // §264 那张脸的三个条件（不在运行＋没有统计＋有那句）齐了才画得出来
    expect(result.current.running).toBe(false)
  })

  it('重读抛出（通道真 reject）⇒ 同一张脸，用抛出的原文', async () => {
    const { result, requestId } = await mountRunning()
    await waitFor(() => expect(statsCalls()).toBeGreaterThan(0))
    M.mode = 'throw'
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(result.current.runStatsUnread?.error ?? '').toContain('通道炸了'))
    expect(result.current.runStats).toBeNull()
  })

  it('重读读到 null（这一轮库里没有 trace 行）⇒ 两块都不说话：没读到≠库里没有', async () => {
    M.mode = 'null'
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(statsCalls()).toBeGreaterThan(0))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.runStats).toBeNull()
    expect(result.current.runStatsUnread, '库里没有≠读不到，不许点亮那句').toBeNull()
  })

  it('重读读到真值⇒填进去、那句收回 null（点重试同一条路的形状）', async () => {
    const { result, requestId } = await mountRunning()
    M.mode = 'fail'
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(result.current.runStatsUnread).not.toBeNull())
    M.mode = 'ok'
    act(() => result.current.loadRunStats(CONV))
    await waitFor(() => expect(result.current.runStatsUnread).toBeNull())
    expect(result.current.runStats).toEqual(STATS)
  })
})

describe('③ 归属判据不许被新档带偏', () => {
  it('迟到 DONE（别的会话）不带统计 ⇒ 当前会话的数字与那句都不动', async () => {
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: STATS })
    const before = statsCalls()
    feedDone(requestId(), { traceStats: undefined }, OTHER)
    expect(result.current.runStats).toEqual(STATS)
    expect(result.current.runStatsUnread).toBeNull()
    expect(statsCalls(), '别的会话的 DONE 不该触发这里重读').toBe(before)
  })
})
