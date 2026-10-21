// Agent 评测的运行侧（V4-Iter-233）：把一个任务跑成一份**环境证据**，再交给判分器。
//
// 为什么这份文件在 src 而不是测试里：真机那一趟（用户点开的 `--eval` 路径）与 CI 的假端点走的是**同一段代码**，
// 放在测试里就等于"CI 验的那条路"与"真机跑的那条路"是两份，而这两份一漂，报上去的通过率就不再是同一件事。
//
// 三处不是可省的细节：
//  · **confirm 档要自动放行**。§231 之后 `fs_write` 要人批，评测里没有人——所以 runner 必须显式替用户点「允许」，
//    并把"我替用户点了"这件事留在结果里（`approvals`）。不加这一条的任务会一律判不过，而被误读成"模型不行"。
//  · **步数取 trace，不取事件计数**。`maxSteps` 是判据的一部分（绕远要能看见），而 trace 才是那条运行真实走了几步的账。
//  · **跑不起来要单独报**（`ran:false`）。端点没连上、引擎抛错、会话没建起来，都不是"模型没过"，混进去第一批数字就是假的。
import fs from 'node:fs'
import path from 'node:path'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { agentTraceRepo } from '../../db/repositories/agent-trace.repo'
import { agentEngine } from '../engine'
import { resolveApproval } from '../tool-approval'
import { getWorkspaceDir, setWorkspaceDir } from '../../tools/fs-tools'
import { collectEvidence, type AttemptOutcome, type EvalTask } from './contract'
import type { AgentEvalInterjectionFact } from '../../../shared/agent-eval'
import { IPC, type AgentDoneEvent, type ToolApprovalRequestEvent } from '../../../shared/types'

export interface RunEvalTaskInput {
  task: EvalTask
  /** 这一发的工作目录（每个任务一份，跑完由调用方决定留不留） */
  workspaceDir: string
  providerId: string
  model: string
  /** 评测一律给全内置工具面：任务判的是"能不能把事办成"，不是"权限勾选对不对" */
  toolPermissions?: string[]
  /** 默认 true：confirm 档自动放行（见文件头）。设为 false 时(confirm 任务会卡到超时)只用于专门测审批 */
  autoApprove?: boolean
  /**
   * 这一发的 `requestId` 定下来时立刻回调一次（V4-Iter-242）。
   * 界面点「停下」要能打断**正在跑的那一发**，而 id 是在这儿生成的、编排层拿不到——
   * 没有这根口子，"停止"就只能等这一发自己跑完，慢的那发能吊住几十秒。
   */
  onStarted?: (requestId: string) => void
}

export interface EvalTaskRun extends AttemptOutcome {
  taskId: string
  steps: number
  /** runner 替用户点了多少次「允许」 */
  approvals: number
  tokens?: number
  /**
   * 这一发用的是哪条会话／哪个助手（V4-Iter-242）。
   * 报告里必须留这根线索：判据说"没过"时，人要能点开那一路看它到底走了几步——
   * 用户选定的口径是**产物留着**，不是跑完扫地。
   */
  conversationId: string
  assistantId: string
  requestId: string
  /** 这一发专属的工作目录（同样留着；里面就是那次运行的产物） */
  workspaceDir: string
  /** 任务要求插话时才有：`accepted` 是"那句进了那轮运行的收件箱"，不等于"它照办了" */
  interjection?: AgentEvalInterjectionFact
}

/** 任务的 setup 落到工作目录里（评测的自变量必须在环境里，不在提示词里） */
export function stageTaskSetup(workspaceDir: string, task: EvalTask): void {
  for (const [rel, content] of Object.entries(task.setup ?? {})) {
    const abs = path.join(workspaceDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }
}

/** 从工作目录里收一份文本文件证据（二进制与读不到的由 `collectEvidence` 自己跳过） */
export async function runEvalTask(input: RunEvalTaskInput): Promise<EvalTaskRun> {
  const { task, workspaceDir, providerId, model } = input
  const toolPermissions = input.toolPermissions ?? ['*']
  const autoApprove = input.autoApprove !== false
  stageTaskSetup(workspaceDir, task)

  const requestId = `eval-${task.id}-${Date.now()}`
  // **把工作目录切到这一发专属的那一份上**：`fs_write`／`fs_read` 认的是 app_config 里那一个全局目录，
  // 不切就会把评测产物写进用户真实的工作目录（而判据读的是本发那份空目录 ⇒ 一律判不过）。
  // 跑完还原；中途抛错也还原（放在 finally 里）。
  const previousWorkspace = getWorkspaceDir()
  setWorkspaceDir(workspaceDir)
  const asst = assistantRepo.save({ name: `评测-${task.id}-${Date.now()}`, toolPermissions })
  const conv = conversationRepo.create({ assistantId: asst.id, title: `评测 ${task.id}`, titleDefault: false })

  const toolSteps: Array<{ name: string; args: string }> = []
  let approvals = 0
  let done: AgentDoneEvent | null = null
  /** 引擎把失败咽成事件而不是抛错（`AGENT_ERROR_EVENT`），所以"跑没跑起来"要看事件、不能只看没抛异常 */
  let runError: string | null = null
  // 插话（V4-Iter-242）：等第 N 个工具调用之后再递，那时运行**确实已经走了一步**，
  // 递早了那句话就只是首条提示的一部分，测不到"运行中被收下"这件事。
  let toolCallsSeen = 0
  let interjectFired = false
  let interjectAccepted = false
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_STEP_EVENT) {
      const evt = data as { toolCall?: { function?: { name?: string; arguments?: string } } }
      const fn = evt.toolCall?.function
      if (fn?.name) {
        toolSteps.push({ name: fn.name, args: fn.arguments ?? '' })
        toolCallsSeen++
        const spec = task.interject
        if (spec && !interjectFired && toolCallsSeen >= spec.afterToolCalls) {
          interjectFired = true
          // 同步递：引擎只在**下一个 llm 步边界**取空（见 §238 那条注释），这里不等它
          interjectAccepted = agentEngine.interject(requestId, `eval-${task.id}`, spec.text)
        }
      }
    }
    if (channel === IPC.AGENT_TOOL_APPROVAL_EVENT) {
      approvals++
      const req = data as ToolApprovalRequestEvent
      if (autoApprove && req.approvalId) resolveApproval(req.approvalId, true)
    }
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    if (channel === IPC.AGENT_ERROR_EVENT) {
      runError = (data as { error?: string }).error ?? 'Agent 运行失败'
    }
  }

  try {
    input.onStarted?.(requestId)
    await agentEngine.run(
      {
        requestId,
        conversationId: conv.id,
        assistantId: asst.id,
        content: task.prompt,
        agentMode: true,
        targets: [{ providerId, model }]
      },
      emit
    )
  } catch (e) {
    // 跑挂了不是"没过"：分档要分开，否则第一批数字会把接线问题算成模型问题
    return {
      taskId: task.id,
      ran: false,
      pass: false,
      steps: 0,
      approvals,
      conversationId: conv.id,
      assistantId: asst.id,
      requestId,
      workspaceDir,
      interjection: interjectionFact(task, interjectFired, interjectAccepted),
      why: `运行失败：${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    setWorkspaceDir(previousWorkspace ?? '')
  }

  // `done` 是在 emit 里被赋值的：TS 只看得到初始的 null，这里要显式过一次类型
  const finished = done as AgentDoneEvent | null
  if (!finished || runError) {
    return {
      taskId: task.id,
      ran: false,
      pass: false,
      steps: agentTraceRepo.statsByRequest(requestId).stepCount,
      approvals,
      conversationId: conv.id,
      assistantId: asst.id,
      requestId,
      workspaceDir,
      interjection: interjectionFact(task, interjectFired, interjectAccepted),
      why: `没跑起来：${runError ?? '这一轮没有产出最终回答'}`
    }
  }
  const finalText = finished.fullContent
  const traceStats = agentTraceRepo.statsByRequest(requestId)
  const interjection = interjectionFact(task, interjectFired, interjectAccepted)
  const evidence = collectEvidence(workspaceDir, toolSteps, finalText, interjection)
  const verdict = task.judge(evidence)
  return {
    taskId: task.id,
    ran: true,
    pass: verdict.pass,
    why: verdict.why,
    steps: traceStats.stepCount,
    tokens: traceStats.totalTokens,
    approvals,
    conversationId: conv.id,
    assistantId: asst.id,
    requestId,
    workspaceDir,
    interjection
  }
}

/**
 * 这一发的插话现场。任务本身不要求插话时给 `undefined`，不是给一条"asked:false"的假事实——
 * 报告与判据都靠这个把"这条任务与插话无关"和"要求了但没递出去"分成两件事。
 */
function interjectionFact(
  task: EvalTask,
  fired: boolean,
  accepted: boolean
): AgentEvalInterjectionFact | undefined {
  const spec = task.interject
  if (!spec) return undefined
  return { asked: true, accepted: fired && accepted, text: spec.text }
}
