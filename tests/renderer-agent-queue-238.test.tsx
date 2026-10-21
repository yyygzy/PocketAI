// @vitest-environment jsdom
// V4-Iter-238：运行中排队消息（入队 / 立即插队）的渲染层那一半。
//
// 这一族的底线是**一句话不许丢、也不许多**。所以每条"消掉条目"的判据都配一条
// "不该消却不消"的反向对照（§241 同轴：没有反向对照，坏成恒空的确认链一路绿灯）：
//  · 条目靠 `clientRef` 对账，不是靠"来了一条 interject 事件"——事件里的 clientRef 换了就不算；
//  · 对账不看"当前看着哪条会话"，因为那句话是否落库与用户这会儿在看哪儿无关。
//    若按会话归属把关，运行结束会把同一句话当成"没送到"再发一遍 ⇒ 库里两条重复。
//  · 运行结束时还挂着"插队中"的一律归回队列：没收到事件确认就是没落库（判据③）。
//  · 中止/出错**不**自动发送：按停止就是要停下来看结果，紧跟一条自动发送等于没停。
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { HookProviders, mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { useAgentChat, MAX_QUEUE_ITEMS } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { zh } from '../src/renderer/src/i18n/zh'
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
const PROVIDERS = [
  { id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }
] as unknown as ProviderRecord[]
const ASSISTANTS = [
  { id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }
] as unknown as AssistantRecord[]
const CONV_RECORD = { id: CONV, assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord
const OTHER_RECORD = { id: OTHER, assistantId: 'a1', title: 'u', modelLabel: null } as unknown as ConversationRecord

const h = {
  step: [] as Array<(e: AgentStepEvent) => void>,
  chunk: [] as Array<(e: AgentChunkEvent) => void>,
  done: [] as Array<(e: AgentDoneEvent) => void>,
  error: [] as Array<(e: AgentErrorEvent) => void>
}

function clearHandlers(): void {
  // 原地清空：`sub()` 捕获的是数组引用，重新赋值会让老闭包继续往旧数组推
  h.step.length = 0
  h.chunk.length = 0
  h.done.length = 0
  h.error.length = 0
}

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

/** 插队通道的应答，用例可按需改（默认"引擎接下了"） */
let interjectReply: (...args: unknown[]) => unknown

beforeEach(() => {
  clearHandlers()
  interjectReply = () => ({ ok: true })
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: {} }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [CONV_RECORD, OTHER_RECORD],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    getConversation: () => null,
    listChildConversations: () => [],
    setModelContextWindow: () => ({ windows: {} }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    interjectAgent: (...args: unknown[]) => interjectReply(...args),
    onAgentStep: sub(h.step),
    onAgentChunk: sub(h.chunk),
    onAgentDone: sub(h.done),
    onAgentError: sub(h.error),
    onConversationTitle: () => () => {}
  })
})

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

const sends = (): Record<string, unknown>[] =>
  pocketaiCalls().filter((c) => c.fn === 'sendMessage').map((c) => c.args[0] as Record<string, unknown>)

const toasts = (): string =>
  Array.from(document.querySelectorAll('[role=status]'))
    .map((n) => n.textContent ?? '')
    .join('\n')

function fireDone(requestId: string, conversationId = CONV): void {
  act(() => {
    h.done[0]!({ requestId, conversationId, finalMessageId: 'x', fullContent: '', stepCount: 2 })
  })
}

function fireError(requestId: string, conversationId = CONV): void {
  act(() => {
    h.error[0]!({ requestId, conversationId, error: '炸了' })
  })
}

function fireInterject(requestId: string, clientRef: string, messageId: string, conversationId = CONV): void {
  act(() => {
    h.step[0]!({ requestId, conversationId, stepIndex: 2, type: 'interject', text: '插队一句', messageId, clientRef })
  })
}

describe('A 入队与本轮结束后的自动发送', () => {
  it('运行中入队：只进条，不起第二轮（正向：条上看得见那句话）', async () => {
    const { result } = await mountRunning()
    act(() => result.current.enqueueText('排队一句'))
    expect(result.current.queue.map((q) => q.text)).toEqual(['排队一句'])
    expect(result.current.queue[0]!.interjecting).toBe(false)
    expect(sends(), '入队不该自己发起运行').toHaveLength(1)
  })

  it('DONE ⇒ 自动把第一条作为新一轮发出，条上清空', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.enqueueText('排队一句'))
    fireDone(requestId())
    expect(sends()).toHaveLength(2)
    expect(sends()[1]!.content).toBe('排队一句')
    expect(result.current.queue).toHaveLength(0)
    expect(result.current.running, '自动发出的那一轮要重新进运行态').toBe(true)
  })

  it('两条排队 ⇒ DONE 只发第一条，第二条等它自己那一轮结束', async () => {
    const { result, requestId } = await mountRunning()
    act(() => {
      result.current.enqueueText('第一句')
      result.current.enqueueText('第二句')
    })
    fireDone(requestId())
    expect(sends()[1]!.content).toBe('第一句')
    expect(result.current.queue.map((q) => q.text)).toEqual(['第二句'])
    fireDone(requestId())
    expect(sends()[2]!.content).toBe('第二句')
    expect(result.current.queue).toHaveLength(0)
  })

  it('反向对照：条上一句都没有时 DONE 不会凭空发起第二轮', async () => {
    const { result, requestId } = await mountRunning()
    fireDone(requestId())
    expect(sends()).toHaveLength(1)
    expect(result.current.queue).toHaveLength(0)
  })

  it('空闲时按「发送」不绕道队列（入队只在运行中这条路存在）', async () => {
    const { result, requestId } = await mountRunning()
    fireDone(requestId())
    expect(result.current.running).toBe(false)
    act(() => {
      void result.current.send('空闲时的一问', [])
    })
    expect(sends()[1]!.content).toBe('空闲时的一问')
    expect(result.current.queue).toHaveLength(0)
  })
})

describe('B 立即插队：条目靠 clientRef 对账', () => {
  it('点立即 ⇒ 交给引擎（requestId＋clientRef＋文本），事件带着同一个 clientRef 回来才消条目并出现用户卡', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    const calls = pocketaiCalls().filter((c) => c.fn === 'interjectAgent')
    expect(calls).toHaveLength(1)
    const payload = calls[0]!.args[0] as { requestId: string; clientRef: string; text: string }
    expect(payload.requestId).toBe(requestId())
    expect(payload.text).toBe('插队一句')
    expect(payload.clientRef).toBeTruthy()
    expect(result.current.queue[0]!.interjecting).toBe(true)
    expect(result.current.messages.some((m) => m.role === 'user' && m.text === '插队一句')).toBe(false)

    fireInterject(requestId(), payload.clientRef, 'msg-77')
    expect(result.current.queue, '确认后条目要消掉').toHaveLength(0)
    const card = result.current.messages.find((m) => m.role === 'user' && m.text === '插队一句')
    expect(card, '确认后用户卡要上屏').toBeTruthy()
    expect(card!.dbId).toBe('msg-77')
    // 插队不是发送：没有为此多发起一轮运行
    expect(sends()).toHaveLength(1)
  })

  it('反向对照：clientRef 不是自己的那条 interject 事件不消条目（别把别人的确认当成自己的）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    fireInterject(requestId(), '别人的-ref', 'msg-77')
    expect(result.current.queue).toHaveLength(1)
    // 卡片照旧追加：那句话是引擎说"我落库了"（messageId 是 DB 真值），与谁的条目无关。
    // 被消掉只能是**自己那条**——如果这里改成"来一条 interject 就把插队中的都消掉"，上面那条就红。
    expect(result.current.queue[0]!.interjecting).toBe(true)
  })

  it('切到别的会话时插队照样被确认：条目必须消掉，否则运行结束会把同一句话再发一遍', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    const ref = result.current.queue[0]!.clientRef
    act(() => result.current.selectConversation(OTHER))
    expect(result.current.queue, '排队条按会话分开，切走就看不到').toHaveLength(0)
    // 事件仍然到得了（引擎那边不知道用户切走了）
    fireInterject(requestId(), ref, 'msg-88', CONV)
    act(() => result.current.selectConversation(CONV))
    expect(result.current.queue, '确认后切回来条上不该再挂着它').toHaveLength(0)
    fireDone(requestId())
    expect(sends(), '已经落库的那句不能再发一遍').toHaveLength(1)
  })

  it('引擎回 RUN_NOT_FOUND：条目归回队列并把话说完（不静默、也不假装已送出）', async () => {
    interjectReply = () => ({ ok: false, error: 'RUN_NOT_FOUND:这轮运行已经结束' })
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    await waitFor(() => expect(result.current.queue[0]!.interjecting).toBe(false))
    expect(toasts()).toContain(zh['agent.interjectRunEnded'])
    expect(sends()).toHaveLength(1)
    expect(result.current.messages.some((m) => m.role === 'user' && m.text === '插队一句')).toBe(false)
    expect(requestId()).toBeTruthy()
  })

  it('通道整个 reject（渲染进程侧断了）：同样归回队列，不留下永远转圈的「插队中」', async () => {
    interjectReply = () => Promise.reject(new Error('No handler registered'))
    const { result } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    await waitFor(() => expect(result.current.queue[0]!.interjecting).toBe(false))
  })
})

describe('C 运行结束时的残留（判据③）', () => {
  it('DONE 时还挂着「插队中」⇒ 视为没送到：归回队列并自动发出，一条不丢', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    fireDone(requestId())
    expect(result.current.queue.every((q) => !q.interjecting), '不许有插队中残留').toBe(true)
    expect(sends()[1]!.content).toBe('插队一句')
    expect(result.current.queue).toHaveLength(0)
  })

  it('ERROR（中止／出错）⇒ 归回队列但**不**自动发送：按停止就是要停下来', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.interjectText('插队一句'))
    fireError(requestId())
    expect(result.current.running).toBe(false)
    expect(sends(), '中止后不该自己起第二轮').toHaveLength(1)
    expect(result.current.queue.map((q) => q.text)).toEqual(['插队一句'])
    expect(result.current.queue[0]!.interjecting).toBe(false)
  })

  it('中止后条上那条可以手动发出（运行已经结束，「发送」走的是新一轮）', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.enqueueText('排队一句'))
    fireError(requestId())
    const ref = result.current.queue[0]!.clientRef
    act(() => result.current.sendQueuedNow(ref))
    expect(sends()[1]!.content).toBe('排队一句')
    expect(result.current.queue).toHaveLength(0)
  })

  it('迟到的 DONE（上一轮的 requestId）既不解残留也不自动发送', async () => {
    const { result, requestId } = await mountRunning()
    const first = requestId()
    act(() => result.current.enqueueText('排队一句'))
    await act(async () => {
      result.current.abort()
    })
    await act(async () => {
      void result.current.send('第二轮', [])
    })
    expect(requestId()).not.toBe(first)
    const before = sends().length
    act(() => {
      h.done[0]!({ requestId: first, conversationId: CONV, finalMessageId: 'x', fullContent: '', stepCount: 1 })
    })
    expect(sends()).toHaveLength(before)
  })
})

describe('D 排队条的边界', () => {
  it(`条满 ${MAX_QUEUE_ITEMS} ⇒ 再多一条不进条，并说出原因`, async () => {
    const { result } = await mountRunning()
    act(() => {
      for (let i = 1; i <= MAX_QUEUE_ITEMS; i++) result.current.enqueueText(`第${i}句`)
    })
    expect(result.current.queue).toHaveLength(MAX_QUEUE_ITEMS)
    expect(result.current.queueFull).toBe(true)
    act(() => result.current.enqueueText('第21句'))
    expect(result.current.queue).toHaveLength(MAX_QUEUE_ITEMS)
    expect(toasts()).toContain(String(MAX_QUEUE_ITEMS))
    expect(result.current.queue.some((q) => q.text === '第21句')).toBe(false)
  })

  it('取消排队只动内存：不发任何 IPC', async () => {
    const { result } = await mountRunning()
    act(() => result.current.enqueueText('不要了那句'))
    const ref = result.current.queue[0]!.clientRef
    const before = pocketaiCalls().length
    act(() => result.current.dropQueued(ref))
    expect(result.current.queue).toHaveLength(0)
    expect(pocketaiCalls()).toHaveLength(before)
  })

  it('别的会话的排队项：切过去看不到，切回来还在，且它的 DONE 不会把它发到当前会话', async () => {
    const { result, requestId } = await mountRunning()
    act(() => result.current.enqueueText('属于 c1 的一句'))
    act(() => result.current.selectConversation(OTHER))
    expect(result.current.queue).toHaveLength(0)
    // c1 那一轮结束，但用户正看着 c2 ⇒ 不该在 c2 里发起运行
    fireDone(requestId())
    expect(sends(), '自动发送只能发给它自己的会话').toHaveLength(1)
    act(() => result.current.selectConversation(CONV))
    expect(result.current.queue.map((q) => q.text)).toEqual(['属于 c1 的一句'])
  })

  it('空白文本不进条（按下入队但什么也没写 ⇒ 条上不出现空行）', async () => {
    const { result } = await mountRunning()
    act(() => {
      result.current.enqueueText('   ')
      result.current.interjectText('')
    })
    expect(result.current.queue).toHaveLength(0)
    expect(pocketaiCalls().filter((c) => c.fn === 'interjectAgent')).toHaveLength(0)
  })
})

// ---------- 真挂载：AgentPanel 上那两颗按钮与那条排队条 ----------

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

const PARENT = {
  id: 'c1',
  assistantId: 'a1',
  title: '会话一',
  // 带 agent: 前缀的那一形状会被 applyLastModelOf 解析成 provider+模型，挂载后不用手点就能发
  modelLabel: 'agent:glm:glm-4.6',
  parentConversationId: null,
  roleKey: null
} as unknown as ConversationRecord

function stubPanel(): Record<string, (...args: any[]) => unknown> {
  return {
    listProviders: () => [glm],
    listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
    listKnowledgeBases: () => [{ id: 'kb1', name: '库一', documentCount: 3 }],
    getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
    setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
    listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) =>
      archivedOnly ? [] : [PARENT],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getLatestRunTraces: () => [],
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    getConversation: () => null,
    listChildConversations: () => [],
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({}),
    getWebSearchConfig: () => ({}),
    getCalendarConfig: () => ({}),
    fetchModels: () => ({ ok: true }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    interjectAgent: (...args: unknown[]) => interjectReply(...args),
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  }
}

const input = (): HTMLTextAreaElement =>
  screen.getByTitle(zh['agent.composerTitle']) as HTMLTextAreaElement

async function panelSend(text: string): Promise<void> {
  await waitFor(() => expect(screen.getByText(zh['common.send'])).toBeTruthy())
  fireEvent.change(input(), { target: { value: text } })
  // 等到那颗按钮真的可点：模型选择是挂载后异步回填的，抢跑会点在一颗 disabled 上（E1 第一版就是这么红的）
  await waitFor(
    () => expect((screen.getByText(zh['common.send']) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByText(zh['common.send']))
}

describe('E 真挂载：输入框在运行中不再被禁用', () => {
  beforeEach(() => {
    stubPocketai(stubPanel())
  })

  it('发送后三键齐（入队／立即插队／停止），输入框还能打字', async () => {
    mountWithProviders(<AgentPanel />)
    await panelSend('第一问')
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy())
    expect(screen.getByTestId('agent-queue-enqueue')).toBeTruthy()
    expect(screen.getByTestId('agent-queue-interject')).toBeTruthy()
    expect((input() as HTMLTextAreaElement).disabled).toBe(false)
    expect(input().getAttribute('placeholder')).toBe(zh['agent.inputPhRunning'])
    // 附件那一发在运行中是关的（排队只带文字）
    expect(screen.getByTitle(zh['agent.queue.textOnly'])).toBeTruthy()
  })

  it('点「入队」⇒ 条上出现那句，且没有第二次 sendMessage；点取消后条消失', async () => {
    mountWithProviders(<AgentPanel />)
    await panelSend('第一问')
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy())
    fireEvent.change(input(), { target: { value: '补一句' } })
    fireEvent.click(screen.getByTestId('agent-queue-enqueue'))
    const bar = await screen.findByTestId('agent-queue-bar')
    expect(bar.textContent).toContain('补一句')
    expect(bar.textContent).toContain(zh['agent.queue.barTitle'])
    expect(pocketaiCalls().filter((c) => c.fn === 'sendMessage')).toHaveLength(1)
    expect((input() as HTMLTextAreaElement).value).toBe('')
    // 取消：条目消失，仍然没有第二次发送
    const drop = document.querySelector('[data-testid^="agent-queue-drop-"]') as HTMLElement
    expect(drop, '条上没有取消按钮').toBeTruthy()
    fireEvent.click(drop)
    await waitFor(() => expect(screen.queryByTestId('agent-queue-bar')).toBeNull())
    expect(pocketaiCalls().filter((c) => c.fn === 'sendMessage')).toHaveLength(1)
  })

  it('点「立即插队」⇒ 走 interjectAgent，条上先显示「插队中」', async () => {
    mountWithProviders(<AgentPanel />)
    await panelSend('第一问')
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy())
    fireEvent.change(input(), { target: { value: '插队一句' } })
    fireEvent.click(screen.getByTestId('agent-queue-interject'))
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'interjectAgent')).toBe(true))
    const calls = pocketaiCalls().filter((c) => c.fn === 'interjectAgent')
    const payload = calls[0]!.args[0] as { clientRef: string }
    expect(await screen.findByTestId(`agent-queue-state-${payload.clientRef}`)).toBeTruthy()
    expect(screen.queryByTestId(`agent-queue-send-${payload.clientRef}`)).toBeNull()
    expect(pocketaiCalls().filter((c) => c.fn === 'sendMessage')).toHaveLength(1)
  })

  it('运行中带附件要排队 ⇒ 说清楚"只带文字"，输入与附件都不许被偷偷清掉', async () => {
    mountWithProviders(<AgentPanel />)
    await panelSend('第一问')
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy())
    // 真路径：把文件拖到输入区（运行中那颗「附件」按钮是关的，拖放没关）
    const file = new File(['附件正文'], 'a.txt', { type: 'text/plain' })
    await act(async () => {
      fireEvent.drop(input().parentElement as HTMLElement, { dataTransfer: { files: [file] } })
    })
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy())
    fireEvent.change(input(), { target: { value: '带着附件的一句' } })
    fireEvent.click(screen.getByTestId('agent-queue-enqueue'))
    await waitFor(() => expect(toasts()).toContain(zh['agent.queue.textOnly']))
    expect(screen.queryByTestId('agent-queue-bar')).toBeNull()
    expect(input().value).toBe('带着附件的一句')
    expect(screen.getByText('a.txt'), '拦下入队不该把用户挑好的附件也清掉').toBeTruthy()
    expect(pocketaiCalls().filter((c) => c.fn === 'sendMessage')).toHaveLength(1)
  })
})

/** Enter 在运行中等于「入队」，不该静默也不该起第二轮 */
describe('F Enter 的分流', () => {
  beforeEach(() => {
    stubPocketai(stubPanel())
  })

  it('运行中按 Enter ⇒ 进条，不发第二次 sendMessage', async () => {
    mountWithProviders(<AgentPanel />)
    await panelSend('第一问')
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy())
    fireEvent.change(input(), { target: { value: 'Enter 那句' } })
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' })
    const bar = await screen.findByTestId('agent-queue-bar')
    expect(bar.textContent).toContain('Enter 那句')
    expect(pocketaiCalls().filter((c) => c.fn === 'sendMessage')).toHaveLength(1)
  })
})
