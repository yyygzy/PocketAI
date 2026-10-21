// @vitest-environment jsdom
// V4-Iter-242 的界面那一半：评测集入口的四张脸与"跑一趟"那条链。
//
// 这一屏最容易骗人的地方和 §222／§226 那一族同源：**"没有"有三种**——
// 还没跑过／读不到上次报告／跑完但一个任务都没过。长成一张脸，用户就会把"评测坏了"读成"我没跑过"。
// 所以每条负向判据都配一条正向对照，且每条都断**逐字取自字典的那句**，不是断"有个元素在"。
//
// 另外三件只在真挂载时才现形的事：入口默认收起（不自动读、更不自动跑——这一屏每跑一次都花额度）、
// 进度事件由订阅回调推出来（首帧闭包读不到最新 state，见 §238 那条）、坏 k 值在发出去之前就被夹住。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ConversationRecord, ProviderRecord } from '../src/shared/types'
import { AGENT_EVAL_MAX_K, type AgentEvalProgressEvent } from '../src/shared/agent-eval'

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

const CONVERSATION = {
  id: 'c1',
  assistantId: 'a1',
  title: '会话一',
  // 带 agent: 前缀 ⇒ 挂载后模型栏自己落到 glm · glm-4.6，评测那一屏的"目标"才有得念
  modelLabel: 'agent:glm:glm-4.6',
  parentConversationId: null,
  roleKey: null
} as unknown as ConversationRecord

let reports: unknown
let reportText: string
let runReply: unknown
let stopReply: unknown
const h = { progress: [] as Array<(e: AgentEvalProgressEvent) => void> }

function subProgress(...args: unknown[]): () => void {
  const fn = args[0] as (e: AgentEvalProgressEvent) => void
  h.progress.push(fn)
  return () => {
    const k = h.progress.indexOf(fn)
    if (k >= 0) h.progress.splice(k, 1)
  }
}

function stubBase(): Record<string, (...args: any[]) => unknown> {
  return {
    listProviders: () => [glm],
    listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
    getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
    setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
    listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) =>
      archivedOnly ? [] : [CONVERSATION],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getLatestRunTraces: () => [],
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    getFallbackTargets: () => ({}),
    setFallbackTarget: () => ({ targets: {} }),
    getConversation: () => null,
    listChildConversations: () => [],
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
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {},
    // ↓ 本批新增的四条通道
    listAgentEvalReports: () => reports,
    readAgentEvalReport: () => ({ text: reportText }),
    runAgentEval: () => runReply,
    stopAgentEval: () => stopReply,
    onAgentEvalProgress: subProgress
  }
}

beforeEach(() => {
  reports = []
  reportText = ''
  runReply = { ok: true }
  stopReply = { stopped: true }
  h.progress.length = 0
  stubPocketai(stubBase())
})

const toggle = async (): Promise<HTMLElement> => (await screen.findByTestId('agent-eval-toggle')) as HTMLElement
const openPanel = async (): Promise<void> => {
  mountWithProviders(<AgentPanel />)
  fireEvent.click(await toggle())
  await screen.findByTestId('agent-eval-panel')
}

/** 造一份"跑完了一趟"的结果：字段形状与主进程那侧一致（桩的形状错了这里就红，别抄实现） */
function fakeResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'suite-1',
    providerId: 'glm',
    model: 'glm-4.6',
    tier: 'smoke',
    k: 2,
    startedAt: 1,
    elapsedMs: 1000,
    interrupted: false,
    stoppedEarly: false,
    attempts: [],
    report: {
      perTask: [
        { id: 'write-named-file', tier: 'smoke', attempts: 2, passed: 2, passAt1: 1, passAllK: 1, notRan: 0, stepOverruns: 0, reasons: [] },
        { id: 'calc-then-write', tier: 'smoke', attempts: 2, passed: 1, passAt1: 0.5, passAllK: 0, notRan: 0, stepOverruns: 1, reasons: ['绕远'] }
      ],
      tasks: 2,
      k: 2,
      reliable: 1,
      everPassed: 2,
      deadTasks: 0
    },
    reportPath: 'D:/x/agent-eval-reports/2026-10-21T04-00-00-000Z.md',
    reportText: 'Agent 评测报告',
    ...over
  }
}

describe('① 入口与"上次报告"那张脸', () => {
  it('默认收起，且不读报告清单——这一屏每跑一次都花额度，挂载不该自己动起来', async () => {
    mountWithProviders(<AgentPanel />)
    await toggle()
    expect(screen.queryByTestId('agent-eval-panel')).toBeNull()
    expect(pocketaiCalls().some((c) => c.fn === 'listAgentEvalReports')).toBe(false)
  })

  it('点开才读：清单空的那句是"还没有报告"，不是"读不到"', async () => {
    reports = []
    await openPanel()
    expect((await screen.findByTestId('agent-eval-reports-empty')).textContent).toBe(zh['agent.eval.reportsEmpty'])
    expect(screen.queryByTestId('agent-eval-reports-unread')).toBeNull()
  })

  it('读不到时明说并给一次重试；重试真的又读了一遍', async () => {
    reports = { ok: false, error: '磁盘读取出错' }
    await openPanel()
    const unread = await screen.findByTestId('agent-eval-reports-unread')
    expect(unread.textContent).toContain('磁盘读取出错')
    expect(screen.queryByTestId('agent-eval-reports-empty')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-eval-reports-retry'))
    await waitFor(() => {
      expect(pocketaiCalls().filter((c) => c.fn === 'listAgentEvalReports').length).toBeGreaterThanOrEqual(2)
    })
  })

  it('有报告：列出那份的第一行，点「打开」读回来的全文原样上屏', async () => {
    reports = [{ fileName: 'r1.md', mtimeMs: 2, firstLine: 'Agent 评测报告　2026-10-21T00:00:00.000Z' }]
    reportText = 'Agent 评测：2 个任务 × 每任务 2 次'
    await openPanel()
    const row = await waitFor(() => {
      const el = document.querySelector('[data-eval-report="r1.md"]')
      if (!el) throw new Error('报告清单没渲染出来')
      return el as HTMLElement
    })
    expect(row.textContent).toContain(zh['agent.eval.openReport'])
    fireEvent.click(row)
    expect((await screen.findByTestId('agent-eval-report-text')).textContent).toContain('2 个任务')
    const call = pocketaiCalls().find((c) => c.fn === 'readAgentEvalReport')
    expect(call!.args).toEqual(['r1.md'])
  })
})

describe('② 跑一趟', () => {
  it('点「跑一趟」发的是模型栏那台＋界面上选的那档，k 被夹在 1..上限之间', async () => {
    runReply = fakeResult()
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'runAgentEval')).toBe(true))
    const call = pocketaiCalls().find((c) => c.fn === 'runAgentEval')!
    // 默认 k 框里那个 2 是"pass^k 需要跑满两次"的意思，不是随手填的
    expect(call.args[0]).toEqual({ providerId: 'glm', model: 'glm-4.6', tier: 'smoke', k: 2 })

    fireEvent.change(screen.getByTestId('agent-eval-k'), { target: { value: '99' } })
    fireEvent.change(screen.getByTestId('agent-eval-tier'), { target: { value: 'full' } })
    fireEvent.click(screen.getByTestId('agent-eval-run'))
    await waitFor(() => expect(pocketaiCalls().filter((c) => c.fn === 'runAgentEval').length).toBe(2))
    const second = pocketaiCalls().filter((c) => c.fn === 'runAgentEval')[1]!
    expect(second.args[0]).toEqual({ providerId: 'glm', model: 'glm-4.6', tier: 'full', k: AGENT_EVAL_MAX_K })
  })

  it('目标那句念的是服务商名＋模型名，不是 id', async () => {
    await openPanel()
    expect((await screen.findByTestId('agent-eval-panel')).textContent).toContain('智谱 GLM · glm-4.6')
  })

  it('进度来自订阅：第 3/8 发那一格真把它写出来', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    runReply = new Promise((r) => {
      resolveRun = r
    })
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'runAgentEval')).toBe(true))
    // 一发事件都还没来：那颗「停止」在＝真在跑（正向对照），那句进度必须先没有——不能自己编一个"第 1/8 发"
    await waitFor(() => expect(screen.getByTestId('agent-eval-stop')).toBeTruthy())
    expect(screen.queryByTestId('agent-eval-progress')).toBeNull()
    await waitFor(() => expect(h.progress.length).toBeGreaterThan(0))
    // 事件是在跑动中被推来的：界面读的是**最新**那一发，不是首帧闭包里的那个
    await waitFor(() => {
      h.progress[0]!({
        runId: 'suite-1',
        tier: 'smoke',
        model: 'glm-4.6',
        providerId: 'glm',
        total: 8,
        done: 2,
        phase: 'attempt-start',
        current: { taskId: 'calc-then-write', attempt: 1 }
      })
    })
    expect((await screen.findByTestId('agent-eval-progress')).textContent).toContain('第 3/8 发')
    expect((await screen.findByTestId('agent-eval-progress')).textContent).toContain('calc-then-write#1')
    expect(screen.getByTestId('agent-eval-stop')).toBeTruthy()
    resolveRun(fakeResult())
    await screen.findByTestId('agent-eval-result')
    expect(screen.queryByTestId('agent-eval-progress')).toBeNull()
  })

  it('跑完了就把两个数并列报：全过 1/2 与至少过一次 2/2，超步数那一格也单独看得见', async () => {
    runReply = fakeResult()
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    const box = await screen.findByTestId('agent-eval-result')
    expect(box.textContent).toContain(zh['agent.eval.reliable'].replace('{n}', '1').replace('{total}', '2'))
    expect(box.textContent).toContain(zh['agent.eval.everPassed'].replace('{n}', '2').replace('{total}', '2'))
    expect(box.textContent).toContain(zh['agent.eval.stepOverran'].replace('{n}', '1'))
    expect(box.textContent).toContain('D:/x/agent-eval-reports')
    // 反向对照：这一趟 deadTasks=0，那句"一次都没跑起来"就不该出现
    expect(box.textContent).not.toContain(zh['agent.eval.deadTasks'].replace('{n}', '0'))
  })

  it('被打断的那趟要自己说明自己：pass^k 那个 0 不是模型不可靠', async () => {
    runReply = fakeResult({ interrupted: true, stoppedEarly: true })
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    const box = await screen.findByTestId('agent-eval-result')
    expect(box.textContent).toContain(zh['agent.eval.stoppedNote'])
  })
})

describe('③ 失败与拒绝', () => {
  it('第二趟被入口闸挡下：显示的是四语那句，不是 main 那行中文原文', async () => {
    runReply = { ok: false, error: 'EVAL_ALREADY_RUNNING:已经有一趟评测在跑了' }
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    const err = await screen.findByTestId('agent-eval-error')
    // 逐字取自字典：把 main 那行中文原文贴上来会短一截，这条相等断言就红
    expect(err.textContent).toBe(zh['agent.eval.alreadyRunning'])
    expect(screen.queryByTestId('agent-eval-result')).toBeNull()
  })

  it('有 Agent 在跑时开不了：EVAL_RUN_BUSY 那句话，且不谎称跑完了', async () => {
    runReply = { ok: false, error: 'EVAL_RUN_BUSY:有 Agent 运行正在进行，先停下再跑评测' }
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    expect((await screen.findByTestId('agent-eval-error')).textContent).toBe(zh['agent.eval.busy'])
  })

  it('点「停下」时其实已经跑完了：那不是失败，界面归位成一句说明', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    runReply = new Promise((r) => {
      resolveRun = r
    })
    stopReply = { stopped: false }
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    fireEvent.click(await screen.findByTestId('agent-eval-stop'))
    expect((await screen.findByTestId('agent-eval-error')).textContent).toBe(zh['agent.eval.stoppedNote'])
    resolveRun(fakeResult())
  })
})

describe('④ 那两句实话', () => {
  it('写明跑的是模型栏当前这台，也写明这一趟会切工作目录', async () => {
    await openPanel()
    const panel = await screen.findByTestId('agent-eval-panel')
    expect(panel.textContent).toContain(zh['agent.eval.targetHint'].replace('{name}', '智谱 GLM · glm-4.6'))
    expect(panel.textContent).toContain(zh['agent.eval.workspaceWarn'])
    expect(panel.textContent).toContain(zh['agent.eval.hint'])
  })

  it('关闭按钮收起这一屏（收起不等于取消正在跑的那趟——那是「停下」的活）', async () => {
    let resolveRun: (v: unknown) => void = () => {}
    runReply = new Promise((r) => {
      resolveRun = r
    })
    await openPanel()
    fireEvent.click(await screen.findByTestId('agent-eval-run'))
    fireEvent.click(screen.getByTestId('agent-eval-close'))
    await waitFor(() => expect(screen.queryByTestId('agent-eval-panel')).toBeNull())
    resolveRun(fakeResult())
  })
})
