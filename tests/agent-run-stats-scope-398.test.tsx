// V4-Iter-398（收 §396 留的那笔账）：「本次运行统计」那一格的重读**问错了对象**
//
// §396 把 DONE 事件里"那一读没读到"跟"这轮真的没步"分开了，但兜底那一发沿用挂载的问法＝
// `getLatestRunStats(conversationId)`＝**这个会话最近一次跑成什么样**。而 engine.ts 的 `safeTrace`
// 写失败只 warn（`src/main/agent/engine.ts:120`），所以"本轮一行 trace 都没落库"是真会发生的：
// 那时会话里最新的一行属于**上一轮**，于是上一轮那份非零账被画在「本次运行统计」下。
//
// 修法＝两问分两发：挂载照旧问"会话最近一次"，DONE 兜底改问"**这一轮**"（按 requestId，走新通道
// `agent:get-run-stats`）；那颗「重试」不许永远问会话那一个，要重问**上一次那个问题**（哪个失败了就重问哪个）。
//
// 前提（本轮零行时旧尺子真的会退到上一轮）由 `tests/agent-run-stats-scope-gate-398.test.ts` 用**真库**演；
// 本文件只管渲染层这一侧：接线、两问分岔、重试的问法、以及两道归属守卫（切会话／新一轮已开跑）。
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
const OTHER_RECORD = { id: OTHER, assistantId: 'a1', title: 't2', modelLabel: null } as unknown as ConversationRecord

/** 上一轮那份非零的账——本枚的缺陷就是它被挂到「本次运行统计」下 */
const PREV_RUN: AgentRunStats = { totalDurationMs: 99000, totalTokens: 99, stepCount: 7 }
/** 本轮的账（按 requestId 取时才是它）；这一档取零行那份，最能显出"两问不同" */
const THIS_RUN: AgentRunStats = { totalDurationMs: 1200, totalTokens: 30, stepCount: 3 }
const ZERO_ROWS: AgentRunStats = { totalDurationMs: 0, totalTokens: 0, stepCount: 0 }

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

function deferred(): Deferred {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const M = vi.hoisted(() => ({
  // 两个开关＝两发各自的脸；'hold'＝把按运行那一发挂在飞上（演迟到响应的两道守卫）
  conv: 'null' as 'ok' | 'fail' | 'null',
  run: 'value' as 'value' | 'fail' | 'throw' | 'hold',
  // vi.hoisted 跑在下面那些 const 之前，所以这里只能写字面量（默认值各发都给"安静那份"）
  convValue: { totalDurationMs: 0, totalTokens: 0, stepCount: 0 } as AgentRunStats,
  runValue: { totalDurationMs: 0, totalTokens: 0, stepCount: 0 } as AgentRunStats,
  runIds: [] as string[],
  held: [] as Deferred[],
  // §398 的第四段：分步明细那两发（按会话／按运行）各自的脸，与统计共用一颗身份
  traceConv: 'prev' as 'prev' | 'empty',
  traceRun: 'empty' as 'empty' | 'fail' | 'throw' | 'hold',
  traceRunIds: [] as string[],
  traceHeld: [] as Deferred[],
  done: [] as Array<(e: AgentDoneEvent) => void>,
  reset(): void {
    this.conv = 'null'
    this.run = 'value'
    this.convValue = { totalDurationMs: 0, totalTokens: 0, stepCount: 0 }
    this.runValue = { totalDurationMs: 0, totalTokens: 0, stepCount: 0 }
    this.runIds.length = 0
    this.held.length = 0
    this.traceConv = 'prev'
    this.traceRun = 'empty'
    this.traceRunIds.length = 0
    this.traceHeld.length = 0
    this.done.length = 0
  }
}))

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
    listConversations: () => [CONV_RECORD, OTHER_RECORD],
    listMessages: () => [],
    getLatestRunStats: () => {
      if (M.conv === 'fail') return { ok: false, error: 'STATS_RUN:会话那一发读不到' }
      if (M.conv === 'null') return null
      return M.convValue
    },
    getRunStats: (requestId: string) => {
      M.runIds.push(String(requestId))
      if (M.run === 'fail') return { ok: false, error: 'STATS_RUN:本轮那一发读不到' }
      if (M.run === 'throw') return Promise.reject(new Error('本轮那一发通道炸了'))
      if (M.run === 'hold') {
        const d = deferred()
        M.held.push(d)
        return d.promise
      }
      return M.runValue
    },
    getSessionStats: () => null,
    // §398：分步明细那两发——会话那一发回"上一轮的步骤"，运行那一发默认回空数组（本轮零行的真值）
    getLatestRunTraces: () => (M.traceConv === 'prev' ? [{ stepIndex: 0, toolName: 'shell' }] : []),
    getRunTraces: (requestId: string) => {
      M.traceRunIds.push(String(requestId))
      if (M.traceRun === 'fail') return { ok: false, error: 'STATS_TRACE:本轮明细读不到' }
      if (M.traceRun === 'throw') return Promise.reject(new Error('本轮明细通道炸了'))
      if (M.traceRun === 'hold') {
        const d = deferred()
        M.traceHeld.push(d)
        return d.promise
      }
      return []
    },
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
    onAgentDone: sub(M.done),
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  })
})

/** 挂一轮真在跑的会话（DONE 事件要过 requestId 归属判据，没 send 过会被整条挡掉） */
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

/** 只把会话挂上、不发那一轮（挂载路径的判据要用"还没开跑"那一帧，send 一开就把上轮统计清了） */
async function mountIdle(): Promise<{ result: { current: ReturnType<typeof useAgentChat> } }> {
  const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
  act(() => result.current.setAssistantId('a1'))
  await waitFor(() => expect(result.current.conversationId).toBe(CONV))
  return { result }
}

const convCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'getLatestRunStats').length
const runCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'getRunStats').length

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

/** 把挂在飞的那一发（统计／明细各自的队列）放行，再刷一层微任务（`act(async)` 只刷一层） */
async function releaseHeld(index: number, value: unknown, which: 'held' | 'traceHeld' = 'held'): Promise<void> {
  await act(async () => {
    M[which][index]!.resolve(value)
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('① 两问分岔：DONE 兜底按这一轮，挂载仍按会话', () => {
  it('缺陷本身＝本轮一行没落库时，**不许**把上一轮那份非零账画在「本次运行统计」下', async () => {
    const { result, requestId } = await mountRunning()
    // 会话最近一次＝上一轮那份非零账；按运行取这一发＝本轮账本里就是零行
    M.convValue = PREV_RUN
    M.conv = 'ok'
    M.runValue = ZERO_ROWS
    feedDone(requestId(), { traceStats: undefined })
    // 门里必须写"到货的见证"（那一格画上东西），不能只等"那一发发出去了"：
    // 计数门 t=0 就放行，紧随的同步读屏读的是响应落地**之前**那一帧⇒负载窗假红（§364 那颗门的 hook 版）
    await waitFor(() => {
      expect(result.current.runStats, '到货见证：按运行那一发的账要落到那一格').toEqual(ZERO_ROWS)
      expect(runCalls(), 'DONE 兜底要真的发出按运行那一发').toBeGreaterThan(0)
    })
    expect(result.current.runStats, '上一轮的账被挂到了「本次运行」下＝本枚的缺陷').not.toEqual(PREV_RUN)
  })

  it('反向钉：这一发确实读到了本轮的账⇒画本轮那份（新档不许把"读到了"也折成沉默）', async () => {
    const { result, requestId } = await mountRunning()
    M.convValue = PREV_RUN
    M.conv = 'ok'
    M.runValue = THIS_RUN
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(result.current.runStats).toEqual(THIS_RUN))
    expect(result.current.runStatsUnread).toBeNull()
  })

  it('正向对照：进入会话那一发**照旧**按会话取（本枚没把挂载路径也换掉）', async () => {
    M.convValue = PREV_RUN
    M.conv = 'ok'
    // idle 挂载（不发那一轮）：`send()` 一开跑就会先把上一轮的统计清掉，
    // 用 mountRunning 就读不到挂载那一发画出来的东西
    const { result } = await mountIdle()
    await waitFor(() => expect(result.current.runStats).toEqual(PREV_RUN))
    expect(convCalls(), '挂载那一发要真的问过会话').toBeGreaterThan(0)
    expect(runCalls(), '还没跑过任何一轮，不该有"按运行"那一发').toBe(0)
  })

  it('DONE 兜底那一发只问按运行那一发，不再多问一次会话', async () => {
    const { result, requestId } = await mountRunning()
    await waitFor(() => expect(convCalls()).toBeGreaterThan(0))
    const beforeConv = convCalls()
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => {
      expect(result.current.runStats, '到货见证：那一格得真的画上按运行那一发的账').toEqual(ZERO_ROWS)
      expect(M.runIds[M.runIds.length - 1]).toBe(requestId())
    })
    expect(convCalls(), '问错了对象＝把"这一轮"当成"最近一次"').toBe(beforeConv)
    expect(runCalls(), '按运行那一发要真的发出去').toBeGreaterThan(0)
  })
})

describe('② 那颗「重试」重问的是**上一次那个问题**', () => {
  it('失败来自"按运行"那一发⇒重试也按运行问（不许偷偷换成会话最近一次）', async () => {
    const { result, requestId } = await mountRunning()
    M.run = 'fail'
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(result.current.runStatsUnread).not.toBeNull())
    const beforeRun = runCalls()
    const beforeConv = convCalls()
    M.run = 'value'
    act(() => result.current.retryRunStats())
    expect(runCalls(), '重试要真的再问一次那一轮').toBe(beforeRun + 1)
    expect(convCalls(), '重试不许改问"会话最近一次"').toBe(beforeConv)
    // 「那句收回」在调用当场就发生了（loader 头一句就清上一句）⇒ 拿它当门＝t=0 就放行；
    // 门里第一句要写到货的见证（§364 那颗门的 hook 版）
    await waitFor(() => expect(result.current.runStats).toEqual(M.runValue))
    expect(result.current.runStatsUnread).toBeNull()
  })

  it('失败来自"按会话"那一发（挂载）⇒重试也按会话问（成对的另一半）', async () => {
    const { result } = await mountRunning()
    M.conv = 'fail'
    act(() => result.current.retryRunStats())
    const askedConversation = pocketaiCalls().filter((c) => c.fn === 'getLatestRunStats').length
    expect(runCalls(), '挂载那一发失败时，重试不该去按运行问').toBe(0)
    expect(askedConversation, '现数按会话那一发被问了几次').toBeGreaterThan(1)
  })
})

describe('③ 两道守卫：切走了别画、新一轮开跑也别把上一轮的数当新的', () => {
  it('按运行那一发还在飞时切到别的会话⇒迟到的响应不许画进新会话那一格', async () => {
    const { result, requestId } = await mountRunning()
    M.run = 'hold'
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    // 切会话：挂载路径会先把那一格清空并问一次会话
    act(() => result.current.selectConversation(OTHER))
    await waitFor(() => expect(convCalls()).toBeGreaterThan(1))
    await releaseHeld(0, THIS_RUN)
    expect(result.current.runStats, '上一轮那发的迟到响应画进了新会话').not.toEqual(THIS_RUN)
    expect(result.current.runStatsUnread, '也不该在新会话那一格点亮"读不到"').toBeNull()
  })

  it('按运行那一发还在飞时新一轮已经开跑⇒上一轮的账不许当成本轮的', async () => {
    const { result, requestId } = await mountRunning()
    const firstRun = requestId()
    M.run = 'hold'
    feedDone(firstRun, { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    // 用户接着发第二句：requestIdRef 换成新一轮的 id
    await act(async () => {
      void result.current.send('再做一件事', [])
    })
    expect(requestId(), '新一轮的 requestId 应该已经换掉').not.toBe(firstRun)
    await releaseHeld(0, THIS_RUN)
    expect(result.current.runStats, '上一轮那发的响应被当成了新一轮的统计').not.toEqual(THIS_RUN)
  })

  it('正向对照：同一轮还没结束守卫不误挡⇒放行后确实填进去（别把守卫写成恒挡）', async () => {
    const { result, requestId } = await mountRunning()
    const rid = requestId()
    M.run = 'hold'
    feedDone(rid, { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    await releaseHeld(0, THIS_RUN)
    expect(result.current.runStats).toEqual(THIS_RUN)
  })
})
describe('④ 分步明细那一格与统计共用同一颗身份（§398 一并收的另一面）', () => {
  it('跑过一轮⇒展开明细按**这一轮**取；本轮零行就是"暂无明细"，不许把上一轮的步骤列在下面', async () => {
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    const beforeConvTrace = pocketaiCalls().filter((c) => c.fn === 'getLatestRunTraces').length
    act(() => result.current.loadLatestTraces())
    const asked = pocketaiCalls().filter((c) => c.fn === 'getRunTraces')
    expect(asked.length, '现数按运行那一发明细被问了几次').toBe(1)
    expect(asked[0]!.args[0], '明细问的必须是统计那一格正在讲的这一轮').toBe(requestId())
    expect(
      pocketaiCalls().filter((c) => c.fn === 'getLatestRunTraces').length,
      '这一格讲的是这一轮⇒不许顺着会话去列上一轮的步骤'
    ).toBe(beforeConvTrace)
    await waitFor(() => expect(result.current.latestTraces, '现数明细：' + JSON.stringify(result.current.latestTraces)).toEqual([]))
    expect(result.current.latestTracesUnread, '空数组是"这一轮确实没有步"，不是读不到').toBeNull()
  })

  it('正向对照：没跑过任何一轮（刚进入会话）⇒展开明细**照旧**按会话取', async () => {
    const { result } = await mountIdle()
    act(() => result.current.loadLatestTraces())
    expect(pocketaiCalls().filter((c) => c.fn === 'getRunTraces').length, '还没有"这一轮"，不该按运行问').toBe(0)
    const askedConv = pocketaiCalls().filter((c) => c.fn === 'getLatestRunTraces')
    expect(askedConv.length, '现数按会话那一发明细').toBe(1)
    expect(askedConv[0]!.args[0]).toBe(CONV)
    // 会话那一发回的是"最近一次"的步骤⇒这一档照旧画出来（本枚没把挂载路径也换掉）
    await waitFor(() => expect(result.current.latestTraces).toEqual([{ stepIndex: 0, toolName: 'shell' }]))
  })

  it('明细读失败⇒那一格说"读不到"（新档不许把失败咽成"这一轮没步"）', async () => {
    const { result, requestId } = await mountRunning()
    feedDone(requestId(), { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    M.traceRun = 'fail'
    act(() => result.current.loadLatestTraces())
    await waitFor(() => expect(result.current.latestTracesUnread ?? '').toContain('读不到'))
    expect(result.current.latestTraces, '失败那一发不许留下"已有明细"的样子').toBeNull()
    expect(result.current.tracesLoading, '失败也要把加载态收掉（§221 那条口径）').toBe(false)
  })

  it('新一轮开跑后，上一轮那发明细的迟到响应不许画进这一轮', async () => {
    const { result, requestId } = await mountRunning()
    const firstRun = requestId()
    feedDone(firstRun, { traceStats: undefined })
    await waitFor(() => expect(runCalls()).toBeGreaterThan(0))
    M.traceRun = 'hold'
    act(() => result.current.loadLatestTraces())
    expect(pocketaiCalls().filter((c) => c.fn === 'getRunTraces').length).toBe(1)
    await act(async () => {
      void result.current.send('再做一件事', [])
    })
    expect(requestId(), '新一轮的 requestId 应该已经换掉').not.toBe(firstRun)
    await releaseHeld(0, [{ stepIndex: 0, toolName: 'shell' }], 'traceHeld')
    expect(result.current.latestTraces, '上一轮那发明细画进了新一轮').toBeNull()
    expect(result.current.tracesLoading, '被丢掉那一发不许把明细卡在加载态').toBe(false)
  })
})
