// @vitest-environment jsdom
// V4-Iter-235：子代理会话从"看得见角色标签、点不开过程"变成一条真入口；
// 顺带把 v50 那三列（入参／返回／模型）第一次落到界面上。
//
// 三处判据不是顺手写的：
//  · 只读判据来自**读出来的身份**（conversation:get），不是"用户从哪儿点进来的"——命令面板那条路会绕过
//    一切导航状态。所以有一条用例专门让 getConversation 失败，看界面是不是宁可把输入区收掉（fail-closed）。
//  · 每条"查不到⇒不给入口"都配一条"看得见⇒给入口"（§241 同轴：没有正向对照，坏成恒空的查询一路绿灯）。
//  · 虚拟消息列表在 jsdom 里不渲染卡片（探针实测：容器在、条目零条，见台账）。所以"切进子会话"这件事
//    这里只能断到**通道层**（listMessages 是按子会话 id 发的那一发）＋横幅；卡片上那几个改动入口
//    到底出没出现，是界面上看得见的东西，交给真机那条 B133，不在这里演。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import { formatDelegationResult } from '../src/shared/delegation-rules'
import type {
  AgentTraceRecord,
  ConversationRecord,
  MessageRecord,
  ProviderRecord
} from '../src/shared/types'

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
  modelLabel: 'glm-4.6',
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

/** 与 CHILD 共享前 8 位的那一条（验"命中不唯一就不给入口"） */
const TWIN = {
  ...CHILD,
  id: 'aabbccdd-9999-9999-9999-444444444444'
} as unknown as ConversationRecord

const NO_SUCH = {
  ...CHILD,
  id: 'ffffffff-0000-0000-0000-000000000000'
} as unknown as ConversationRecord

let tracesFor: AgentTraceRecord[]

function trace(over: Partial<AgentTraceRecord>): AgentTraceRecord {
  return {
    id: 't1',
    requestId: 'r1',
    conversationId: 'c1',
    parentRequestId: null,
    stepIndex: 1,
    stepType: 'tools',
    toolName: 'fs_read',
    durationMs: 10,
    status: 'success',
    createdAt: 5,
    ...over
  } as AgentTraceRecord
}

const delegateResult = (childId: string): string =>
  formatDelegationResult({ role: 'researcher', childConversationId: childId, content: '检索结论' })

let records: Record<string, ConversationRecord | null | { ok: false; error: string }>
let childrenFor: Record<string, ConversationRecord[] | { ok: false; error: string }>
/** 通道层留痕：虚拟列表在 jsdom 里不出卡片，"看的是哪条会话"只能这样断 */
let identityReads: string[]
let childReads: string[]

/** 桩的底座：读的是上面那几个可变夹具，所以每个用例改夹具就够了，不用重铺一整套 */
function stubBase(): Record<string, (...args: any[]) => unknown> {
  return {
    listProviders: () => [glm],
    listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
    getUiPrefs: () => ({
      ok: true,
      data: { agentAssistantId: 'a1', agentConversationId: 'c1' }
    }),
    setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
    listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) =>
      archivedOnly ? [] : [PARENT],
    listMessages: (id: string) =>
      [{ id: `m-${id}`, conversationId: id, role: 'user', content: '跑一趟', createdAt: 1 }] as MessageRecord[],
    getLatestRunStats: (id: string) =>
      id === 'c1' ? { stepCount: 2, totalDurationMs: 1200, totalTokens: 900 } : null,
    getSessionStats: () => ({ runCount: 1, totalDurationMs: 1200, totalTokens: 900 }),
    getLatestRunTraces: () => tracesFor,
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    // §237：挂载时要读这张备用表（桩给空表＝没有一台设过备用）
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: (id: string) => {
      identityReads.push(id)
      return records[id] ?? null
    },
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
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  }
}

beforeEach(() => {
  records = { c1: PARENT, [CHILD.id]: CHILD, [TWIN.id]: TWIN }
  childrenFor = { c1: [CHILD] }
  tracesFor = [trace({})]
  identityReads = []
  childReads = []
  stubPocketai(stubBase())
})

/** 挂载并等到"会话已选中、本次运行统计已到货"那一帧（分步明细那格就挂在这条线上） */
async function mountReady() {
  mountWithProviders(<AgentPanel />)
  await waitFor(() => expect(screen.getByTitle(zh['agent.runStatsDetail'])).toBeTruthy())
}

/** 展开分步明细 */
async function openStepDetail() {
  await mountReady()
  fireEvent.click(screen.getByTitle(zh['agent.runStatsDetail']))
  await waitFor(() => expect(screen.getByText(zh['agent.traceType.tools'])).toBeTruthy())
}

async function openChild(child: ConversationRecord) {
  fireEvent.click(await screen.findByTestId('sub-sessions-toggle'))
  fireEvent.click(await screen.findByTestId(`sub-session-open-${child.id}`))
  await screen.findByTestId('sub-session-banner')
}

describe('「子代理会话」那一格', () => {
  it('有子会话 ⇒ 那一格出现；展开是角色标签，点下去切进那条会话（消息按子会话 id 取）', async () => {
    await mountReady()
    const toggle = await screen.findByTestId('sub-sessions-toggle')
    expect(toggle.textContent).toContain(zh['agent.subSessions'].replace('{n}', '1'))
    await openChild(CHILD)
    const banner = screen.getByTestId('sub-session-banner')
    expect(banner.textContent).toContain(zh['agent.role.researcher'])
    expect(banner.textContent).toContain(zh['agent.subSessionNote'])
    expect(identityReads[identityReads.length - 1]).toBe(CHILD.id)
    // 通道层证据：虚拟列表在 jsdom 里不出卡片，所以"看的是子会话那份消息"只能这样断
    const lastMessages = [...pocketaiCalls()].reverse().find((c) => c.fn === 'listMessages')
    expect(lastMessages?.args).toEqual([CHILD.id])
  })

  it('反向对照：一条子会话都没有 ⇒ 那一格压根不出现（不把"零趟"演成一个入口）', async () => {
    childrenFor = { c1: [] }
    await mountReady()
    expect(screen.queryByTestId('sub-sessions-toggle')).toBeNull()
    expect(screen.queryByTestId('sub-sessions-unread')).toBeNull()
  })

  it('读不到子会话：那一句**不藏在折叠态后面**，且不给"子代理会话 · 0"这种看起来正常的读数', async () => {
    childrenFor = { c1: { ok: false, error: '主进程没应答' } }
    await mountReady()
    const line = await screen.findByTestId('sub-sessions-unread')
    expect(line.textContent).toContain(zh['agent.subSessionsUnread'])
    expect(screen.getByTitle('主进程没应答')).toBeTruthy()
    expect(screen.queryByTestId('sub-sessions-toggle')).toBeNull()
  })

  it('点重试 ⇒ 再读一趟，读到了那一格才出来（那几发读没有自动重试，这是唯一一次）', async () => {
    childrenFor = { c1: { ok: false, error: '抖了一下' } }
    await mountReady()
    const before = childReads.length
    childrenFor = { c1: [CHILD] }
    fireEvent.click(await screen.findByTestId('sub-sessions-retry'))
    await waitFor(() => expect(screen.getByTestId('sub-sessions-toggle')).toBeTruthy())
    expect(childReads.length).toBeGreaterThan(before)
  })
})

describe('只读那一档（判据来自读出来的身份）', () => {
  it('切进子会话：输入区整块不渲染（不是禁用一个框），横幅给一条返回，返回后输入区回来', async () => {
    await mountReady()
    expect(screen.getByText(zh['common.send'])).toBeTruthy()
    await openChild(CHILD)
    expect(screen.queryByText(zh['common.send'])).toBeNull()
    fireEvent.click(screen.getByTestId('sub-session-back'))
    await waitFor(() => expect(screen.queryByTestId('sub-session-banner')).toBeNull())
    expect(await screen.findByText(zh['common.send'])).toBeTruthy()
    expect(identityReads[identityReads.length - 1]).toBe('c1')
  })

  it('点开那一瞬间不许先亮一下输入框（乐观写入必须活过 effect 那一次复位）', async () => {
    await mountReady()
    fireEvent.click(screen.getByTestId('sub-sessions-toggle'))
    fireEvent.click(await screen.findByTestId(`sub-session-open-${CHILD.id}`))
    // **故意不 await**：这一帧就是"openSubSession 写的那一笔"与"换会话 effect 的复位"谁赢的现场。
    // 复位赢了 ⇒ 只读判据短暂变 false，输入框在子会话里闪出来一下（发得快的人真按得下去）
    expect(screen.queryByText(zh['common.send'])).toBeNull()
    await screen.findByTestId('sub-session-banner')
  })

  it('身份读不到 ⇒ 宁可收掉输入区，也不让人往一条身份不明的会话里发；那句话带原因', async () => {
    records = { c1: { ok: false, error: '库被占着' } }
    await mountReady()
    const line = await screen.findByTestId('sub-session-unread')
    expect(line.textContent).toContain(zh['agent.identityUnread'])
    expect(screen.getByTitle('库被占着')).toBeTruthy()
    expect(screen.queryByText(zh['common.send'])).toBeNull()
  })

  it('身份读到"库里没有这条" ⇒ 按能发处理（不发明第三种脸），也没有横幅', async () => {
    records = { c1: null }
    await mountReady()
    expect(screen.queryByTestId('sub-session-unread')).toBeNull()
    expect(screen.queryByTestId('sub-session-banner')).toBeNull()
    expect(await screen.findByText(zh['common.send'])).toBeTruthy()
  })

  it('真抛错那一面（不是 {ok:false}）也接得住：读失败的脸是"读不到"，不是永远卡在还没读到', async () => {
    stubPocketai({
      ...stubBase(),
      // 真实 preload 走 ipcRenderer.invoke：它不同步抛，是给慢的 rejected Promise（形状要照真的来）
      getConversation: () => Promise.reject(new Error('通道整段没应答'))
    })
    await mountReady()
    const line = await screen.findByTestId('sub-session-unread')
    expect(line.textContent).toContain(zh['agent.identityUnread'])
    expect(screen.queryByText(zh['common.send'])).toBeNull()
  })

  it('孙级：子会话自己也有子会话时，那一格在子会话视图里照样出现（每层只看自己派出去的那几趟）', async () => {
    childrenFor = { c1: [CHILD], [CHILD.id]: [NO_SUCH] }
    await mountReady()
    await openChild(CHILD)
    fireEvent.click(await screen.findByTestId('sub-sessions-toggle'))
    expect(await screen.findByTestId(`sub-session-open-${NO_SUCH.id}`)).toBeTruthy()
  })
})

describe('分步明细里的入参／返回／模型', () => {
  it('有记录的行：展开后三列逐字出现（模型是这一步实际跑的那台，不是会话上那个标签）', async () => {
    tracesFor = [
      trace({ id: 'io1', toolArgs: 'fs_read {"path":"a.md"}', toolResult: 'fs_read OK 正文', model: 'glm-4.6' })
    ]
    await openStepDetail()
    fireEvent.click(await screen.findByTestId('trace-io-io1'))
    expect((await screen.findByTestId('trace-model')).textContent).toContain(zh['agent.traceModel'])
    expect((await screen.findByTestId('trace-model')).textContent).toContain('glm-4.6')
    expect((await screen.findByTestId('trace-args')).textContent).toContain('fs_read {"path":"a.md"}')
    expect((await screen.findByTestId('trace-result')).textContent).toContain('正文')
  })

  it('v50 之前的旧行（三列都 NULL）：说明是「没留下记录」，而不是给一个空白框（§222 那一族）', async () => {
    tracesFor = [trace({ id: 'old1', toolArgs: undefined, toolResult: undefined, model: undefined })]
    await openStepDetail()
    expect((await screen.findByTestId('trace-no-io')).textContent).toContain(zh['agent.traceNoIo'])
    expect(screen.queryByTestId('trace-io-old1')).toBeNull()
  })

  it('委派那一步：返回值头部那 8 位前缀命中唯一一条子会话 ⇒ 给「打开子代理过程」，点下去切进去', async () => {
    tracesFor = [trace({ id: 'dlv', toolName: 'delegate_task', toolResult: delegateResult(CHILD.id) })]
    await openStepDetail()
    fireEvent.click(await screen.findByTestId('trace-open-sub-dlv'))
    await screen.findByTestId('sub-session-banner')
    expect(identityReads[identityReads.length - 1]).toBe(CHILD.id)
  })

  it('负向对照①：前 8 位撞上两条子会话 ⇒ 不给入口（宁可不给，也不赌是哪一趟）', async () => {
    childrenFor = { c1: [CHILD, TWIN] }
    tracesFor = [trace({ id: 'dlv2', toolName: 'delegate_task', toolResult: delegateResult(CHILD.id) })]
    await openStepDetail()
    expect(screen.queryByTestId('trace-open-sub-dlv2')).toBeNull()
  })

  it('负向对照②：前缀查无此人（子会话已被删）⇒ 同样不给入口，也不报错', async () => {
    childrenFor = { c1: [NO_SUCH] }
    tracesFor = [trace({ id: 'dlv3', toolName: 'delegate_task', toolResult: delegateResult(CHILD.id) })]
    await openStepDetail()
    expect(screen.queryByTestId('trace-open-sub-dlv3')).toBeNull()
    expect(screen.queryByTestId('sub-sessions-unread')).toBeNull()
  })

  it('同一步并行委派两趟（两个前缀各命中唯一一条）⇒ 两个入口都给，不是只给第一个', async () => {
    const OTHER = {
      ...CHILD,
      id: '12345678-1111-2222-3333-444444444444'
    } as unknown as ConversationRecord
    childrenFor = { c1: [CHILD, OTHER] }
    tracesFor = [
      trace({
        id: 'dlv4',
        toolName: 'delegate_task',
        toolResult: `${delegateResult(CHILD.id)}\n${delegateResult(OTHER.id)}`
      })
    ]
    await openStepDetail()
    await screen.findByTestId('trace-io-dlv4')
    expect(screen.getAllByTestId('trace-open-sub-dlv4')).toHaveLength(2)
  })
})
