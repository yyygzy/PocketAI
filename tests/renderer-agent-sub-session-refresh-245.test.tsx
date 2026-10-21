// @vitest-environment jsdom
// V4-Iter-245：委派**跑完当场**就该看见子会话入口。
//
// 由来是 2026-10-21 真机补 B133 那次：17 步那一趟派出了两条子会话，跑完立刻展开分步明细，
// `trace-open-sub-*` 是 0、会话级「子代理会话 · N」那一格也不在；切走再回来才出现。
// 根因在渲染层：子会话那份列表只在**进入会话时**读一次，运行结束那条路径没去刷它。
//
// 判据取向（本仓一贯）：
//  · 主判据断的是**屏幕上出现那一格**，不是"我调了一次函数"——当场看不见正是用户看到的样子；
//  · 每条"该刷新"都配"不该刷新"：迟到的 DONE、属于别的会话的 DONE 都不许动当前这一格；
//  · 刷新失败不许把已有列表咽成空（§222 那一族：空列表和"没派过子代理"长得一模一样）。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AgentDoneEvent, AgentErrorEvent, ConversationRecord, ProviderRecord } from '../src/shared/types'

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

const PARENT = {
  id: 'c1',
  assistantId: 'a1',
  title: '父会话',
  // 带 agent: 前缀 ⇒ applyLastModelOf 认得出 provider＋模型，挂载后不用手点就能发
  modelLabel: 'agent:glm:glm-4.6',
  parentConversationId: null,
  roleKey: null
} as unknown as ConversationRecord

const CHILD = {
  id: 'aabbccdd-1111-2222-3333-444444444444',
  assistantId: 'a1',
  title: '子代理 · researcher',
  modelLabel: 'agent:glm:glm-4.6',
  parentConversationId: 'c1',
  roleKey: 'researcher'
} as unknown as ConversationRecord

const OTHER_CONV = 'c2'

/** 订阅桩要**记全部订阅者**：StrictMode 会双订阅，只留 h.done[0] 会喂到已被卸载的那一份 */
const h = {
  done: [] as Array<(e: AgentDoneEvent) => void>,
  error: [] as Array<(e: AgentErrorEvent) => void>
}
const capture =
  (bucket: Array<(e: never) => void>) =>
  (...args: unknown[]): (() => void) => {
    const fn = args[0] as (e: never) => void
    bucket.push(fn)
    return () => {
      const i = bucket.indexOf(fn)
      if (i >= 0) bucket.splice(i, 1)
    }
  }

let childrenFor: Record<string, ConversationRecord[] | { ok: false; error: string }>
let childReads: string[]

function stubBase(): Record<string, (...args: any[]) => unknown> {
  return {
    listProviders: () => [glm],
    listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
    listKnowledgeBases: () => [],
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
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    // 父会话的身份：不是子会话（record.parentConversationId 为 null）⇒ 输入区照常可发
    getConversation: (id: string) => (id === 'c1' ? PARENT : null),
    listChildConversations: (id: string) => {
      childReads.push(id)
      return childrenFor[id] ?? []
    },
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({}),
    getWebSearchConfig: () => ({}),
    getCalendarConfig: () => ({}),
    fetchModels: () => ({ ok: true }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    interjectAgent: () => ({ ok: true }),
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: capture(h.done as never[]) as never,
    onAgentError: capture(h.error as never[]) as never,
    onConversationTitle: () => () => {}
  }
}

beforeEach(() => {
  h.done.length = 0
  h.error.length = 0
  childrenFor = { c1: [] }
  childReads = []
  stubPocketai(stubBase())
})

const input = (): HTMLTextAreaElement =>
  screen.getByTitle(zh['agent.composerTitle']) as HTMLTextAreaElement

/** 发一轮，等到运行中那颗「停止」出现，返回这一发的 requestId */
async function sendOne(): Promise<string> {
  await waitFor(() => expect(screen.getByText(zh['common.send'])).toBeTruthy())
  // 发送键是**有字才可点**（空输入时它就是灰的）⇒ 先打字再等它真的可点，抢跑会点在 disabled 上
  fireEvent.change(input(), { target: { value: '派个子代理去查' } })
  await waitFor(
    () => expect((screen.getByText(zh['common.send']) as HTMLButtonElement).disabled).toBe(false),
    { timeout: 6000 }
  )
  fireEvent.click(screen.getByText(zh['common.send']))
  await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy(), { timeout: 6000 })
  const sent = pocketaiCalls().filter((c) => c.fn === 'sendMessage')
  return (sent[sent.length - 1]!.args[0] as { requestId: string }).requestId
}

const 那一格 = (): HTMLElement | null => screen.queryByTestId('sub-sessions-toggle')
const 读到几次 = (): number => childReads.filter((id) => id === 'c1').length

/** 把事件喂给**所有**还活着的订阅者（少喂一份＝测的是被丢掉的那个闭包） */
function fireDone(requestId: string, conversationId = 'c1'): void {
  const list = [...h.done]
  for (const fn of list) (fn as (e: unknown) => void)({
    requestId,
    conversationId,
    finalMessageId: 'x',
    fullContent: '',
    stepCount: 2
  })
}

describe('跑完当场：子会话入口不该等"切走再回来"', () => {
  it('挂载时没有子会话 ⇒ 那一格不在；这一轮派出一条后 DONE ⇒ 那一格当场出现（并真的重读了一次）', async () => {
    mountWithProviders(<AgentPanel />)
    const requestId = await sendOne()
    // 挂载那一次读到的是空表
    await waitFor(() => expect(读到几次()).toBeGreaterThanOrEqual(1))
    expect(那一格()).toBeNull()
    const before = 读到几次()

    // 这一轮派出去一条子会话（库里现在有；DONE 之前才改夹具＝模拟"运行期间才建出来"）
    childrenFor = { c1: [CHILD] }
    fireDone(requestId)

    await waitFor(() => expect(那一格()).toBeTruthy(), { timeout: 6000 })
    expect(那一格()!.textContent).toContain(zh['agent.subSessions'].replace('{n}', '1'))
    expect(读到几次(), 'DONE 之后要多一次重读').toBeGreaterThan(before)
  })

  it('反向对照：DONE 属于**别的会话** ⇒ 不重读当前这条，那一格也不冒出来', async () => {
    mountWithProviders(<AgentPanel />)
    const requestId = await sendOne()
    await waitFor(() => expect(读到几次()).toBeGreaterThanOrEqual(1))
    const before = 读到几次()
    childrenFor = { c1: [CHILD] }

    fireDone(requestId, OTHER_CONV)

    await waitFor(() => expect(screen.queryByText(zh['common.stop'])).toBeNull(), { timeout: 6000 })
    await new Promise((r) => setTimeout(r, 400))
    expect(读到几次(), '别的会话的 DONE 不该动这条会话的列表').toBe(before)
    expect(那一格()).toBeNull()
  })

  it('反向对照：旧一轮迟到的 DONE（requestId 不是这次发的）⇒ 同样不重读', async () => {
    mountWithProviders(<AgentPanel />)
    await sendOne()
    await waitFor(() => expect(读到几次()).toBeGreaterThanOrEqual(1))
    const before = 读到几次()
    childrenFor = { c1: [CHILD] }

    fireDone('agent_不是这一发')

    await new Promise((r) => setTimeout(r, 400))
    expect(读到几次()).toBe(before)
    expect(那一格()).toBeNull()
  })

  it('出错收尾也算：这一轮跑挂了，但已经建出来的那一条当场就该看得见', async () => {
    mountWithProviders(<AgentPanel />)
    const requestId = await sendOne()
    await waitFor(() => expect(读到几次()).toBeGreaterThanOrEqual(1))
    const before = 读到几次()
    childrenFor = { c1: [CHILD] }

    const list = [...h.error]
    for (const fn of list) {
      (fn as (e: unknown) => void)({ requestId, conversationId: 'c1', error: '端点断了' })
    }

    await waitFor(() => expect(那一格()).toBeTruthy(), { timeout: 6000 })
    expect(读到几次()).toBeGreaterThan(before)
  })

  it('刷新那一读失败 ⇒ 已有列表**留着**并补一句"读不到"（不把失败咽成"没派过子代理"）', async () => {
    childrenFor = { c1: [CHILD] }
    mountWithProviders(<AgentPanel />)
    const requestId = await sendOne()
    await waitFor(() => expect(那一格()).toBeTruthy(), { timeout: 6000 })
    const n = 读到几次()

    childrenFor = { c1: { ok: false, error: '库锁了' } }
    fireDone(requestId)

    await waitFor(() => expect(screen.getByTestId('sub-sessions-unread')).toBeTruthy(), { timeout: 6000 })
    expect(那一格()!.textContent, '旧的那一条还在，只是多了一句读不到').toContain(
      zh['agent.subSessions'].replace('{n}', '1')
    )
    expect(读到几次()).toBeGreaterThan(n)
  })
})
