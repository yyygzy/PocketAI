// Agent 评测的编排侧（V4-Iter-242）：把「一批任务 × 每任务 k 次」跑成一份能读的报告，并落盘。
//
// 为什么这一层单独成文件：`live.ts` 管的是**一发**（工作目录、放行、证据、判分），
// 而"跑一趟"这件事的三个约束都在编排上：
//  · **必须串行**。Agent 的工作目录是 `app_config` 里那**一个全局键**（§233 撞出来的第一条），
//    两发并行就是互相切目录——判据读到的会是别人的产物。
//  · **每一发一份新会话**。产物留着（用户选定）是有意为之：判据说"没过"时，人要点开那条会话看它走了几步，
//    所以 `conversationId` 一路带到报告文本里，不是内部字段。
//  · **被打断的那趟数字要自己说明自己**。`passAllK` 要求跑满 k 次，中途停下必然全 0——
//    报告不写"这趟只跑了 n/N 发"，那个 0 就会被读成"这台模型不可靠"。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../../portable'
import { providerRepo } from '../../db/repositories/provider.repo'
import { agentEngine } from '../engine'
import {
  AGENT_EVAL_DEFAULT_K,
  AGENT_EVAL_MAX_K,
  type AgentEvalAttempt,
  type AgentEvalProgressEvent,
  type AgentEvalReportEntry,
  type AgentEvalRunResult,
  type AgentEvalTier
} from '../../../shared/agent-eval'
import {
  AGENT_EVAL_TASKS,
  aggregateSuite,
  formatSuiteReport,
  smokeTasks,
  type AttemptOutcome,
  type EvalTask
} from './contract'
import { runEvalTask, type EvalTaskRun } from './live'

/** 落盘目录：与 `skills/`、`agent-tool-outputs/` 同族，都在 `DATA_DIR` 下（便携包搬家时一起走） */
export function agentEvalReportDir(): string {
  return path.join(DATA_DIR, 'agent-eval-reports')
}

/** 每一发专属的工作目录根（跑完**不删**：里面就是那次运行的产物，与报告里的会话 id 配成一对） */
export function agentEvalWorkspaceRoot(runId: string): string {
  return path.join(DATA_DIR, 'agent-eval', runId)
}

export interface RunAgentEvalSuiteInput {
  providerId: string
  model: string
  /** 默认冒烟档：低配机跑全量是几十分钟量级（§157 的耗时账），默认档必须收得住 */
  tier?: AgentEvalTier
  /** 每个任务跑几次；上限 `AGENT_EVAL_MAX_K`——这一档直接乘在用户的额度与等待上 */
  k?: number
  onProgress?: (event: AgentEvalProgressEvent) => void
  /** 用户点了「停下」：正在跑的那发由调用方 abort，这里负责**不再开新的一发** */
  stopped?: () => boolean
  /** 每一发的 `requestId` 定下来时报告一次（「停下」要能打断正在跑的那发，见 `runEvalTask` 的 `onStarted`） */
  onAttemptStarted?: (requestId: string) => void
}

function tasksFor(tier: AgentEvalTier): EvalTask[] {
  return tier === 'full' ? AGENT_EVAL_TASKS : smokeTasks()
}

/**
 * 跑一趟评测。**串行**，且每发之间把全局工作目录交还（`runEvalTask` 的 finally 已经还原）。
 * `tier`／`k` 决定发数；`stopped()` 为真时提前收尾，返回结果里 `interrupted` 与 `stoppedEarly` 分开写。
 */
export async function runAgentEvalSuite(input: RunAgentEvalSuiteInput): Promise<AgentEvalRunResult> {
  const tier = input.tier ?? 'smoke'
  const k = Math.min(Math.max(1, Math.trunc(input.k ?? AGENT_EVAL_DEFAULT_K)), AGENT_EVAL_MAX_K)
  const tasks = tasksFor(tier)
  const runId = `suite-${Date.now()}`
  const startedAt = Date.now()
  const total = tasks.length * k
  const workspaceRoot = agentEvalWorkspaceRoot(runId)
  fs.mkdirSync(workspaceRoot, { recursive: true })

  const attempts: AgentEvalAttempt[] = []
  let stoppedEarly = false
  const progress = (event: Omit<AgentEvalProgressEvent, 'runId' | 'tier' | 'model' | 'providerId' | 'total' | 'done'>): void => {
    input.onProgress?.({
      runId,
      tier,
      model: input.model,
      providerId: input.providerId,
      total,
      done: attempts.length,
      ...event
    })
  }

  for (const task of tasks) {
    for (let attempt = 1; attempt <= k; attempt++) {
      if (input.stopped?.()) {
        stoppedEarly = true
        progress({ phase: 'stopped' })
        break
      }
      const workspaceDir = path.join(workspaceRoot, `${task.id}-${attempt}`)
      fs.mkdirSync(workspaceDir, { recursive: true })
      progress({ phase: 'attempt-start', current: { taskId: task.id, attempt } })
      const run = await runEvalTask({
        task,
        workspaceDir,
        providerId: input.providerId,
        model: input.model,
        onStarted: input.onAttemptStarted
      })
      const shaped: AgentEvalAttempt = { ...toAttempt(task, attempt, run) }
      attempts.push(shaped)
      progress({ phase: 'attempt-done', current: { taskId: task.id, attempt }, attempt: shaped })
    }
    if (stoppedEarly) break
  }

  const outcomes = new Map<string, AttemptOutcome[]>()
  for (const task of tasks) {
    outcomes.set(task.id, attempts.filter((a) => a.taskId === task.id))
  }
  // 聚合按**这一趟实际选出来的任务**算，不是按整张任务表：跑冒烟档时不许把全量那几条算进分母
  const ranTasks = attempts.length ? tasks.filter((t) => attempts.some((a) => a.taskId === t.id)) : []
  const report = aggregateSuite(ranTasks, k, outcomes)
  const elapsedMs = Date.now() - startedAt
  const reportText = buildReportText({
    runId,
    providerId: input.providerId,
    model: input.model,
    tier,
    k,
    startedAt,
    elapsedMs,
    stoppedEarly,
    plannedAttempts: total,
    report,
    attempts,
    tasks
  })
  const reportPath = path.join(agentEvalReportDir(), `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.md`)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, reportText, 'utf-8')

  return {
    runId,
    providerId: input.providerId,
    model: input.model,
    tier,
    k,
    startedAt,
    elapsedMs,
    interrupted: attempts.length < total,
    stoppedEarly,
    attempts,
    report,
    reportPath,
    reportText
  }
}

/**
 * 一发的结果 → 报告里那一行。`attempt`／`tier` 是编排层才有的坐标，
 * `runEvalTask` 只知道自己这一发，所以这两个数在这儿补，不在 runner 里塞参数。
 */
function toAttempt(task: EvalTask, attempt: number, run: EvalTaskRun): AgentEvalAttempt {
  return { ...run, tier: task.tier, attempt }
}

function buildReportText(meta: {
  runId: string
  providerId: string
  model: string
  tier: AgentEvalTier
  k: number
  startedAt: number
  elapsedMs: number
  stoppedEarly: boolean
  plannedAttempts: number
  report: ReturnType<typeof aggregateSuite>
  attempts: AgentEvalAttempt[]
  tasks: EvalTask[]
}): string {
  const head = [
    `Agent 评测报告　${new Date(meta.startedAt).toISOString()}`,
    // 念**服务商名**而不是 uuid：2026-10-21 第一次真机读这份报告时就发现那行是 `354da5bd-… · Qwen/Qwen3-8B`，
    // 报告是给人读的，一串 id 等于没念。查不到名字（服务商已删）就退回 id——不许留空
    `目标：${providerRepo.get(meta.providerId)?.name || meta.providerId} · ${meta.model}　档位：${meta.tier}　每任务 ${meta.k} 次`,
    `计划 ${meta.plannedAttempts} 发，实际跑了 ${meta.attempts.length} 发，用时 ${Math.round(meta.elapsedMs / 1000)} 秒`
  ]
  if (meta.stoppedEarly) {
    // 被打断的那趟 `pass^k` 必然是 0（口径要求跑满），这句是防止那个 0 被读成"模型不可靠"
    head.push('⚠️ 这趟被中途喊停：下面的 pass^k 一律按"没跑满"算 0，不要与跑满的那趟并排比。')
  }
  const lines = [head.join('\n'), formatSuiteReport(meta.report)]
  const taskById = new Map(meta.tasks.map((t) => [t.id, t]))

  const trail = meta.attempts.map(
    (a) =>
      `- ${a.taskId} 第 ${a.attempt} 次：${describeAttempt(taskById.get(a.taskId), a)}｜会话 ${a.conversationId}｜工作目录 ${a.workspaceDir}｜步 ${a.steps ?? 0}｜放行 ${a.approvals} 次${a.interjection ? `｜插话${a.interjection.accepted ? '被收下' : '没被收下'}` : ''}${a.why ? `｜${a.why}` : ''}`
  )
  return [lines.join('\n'), '逐发现场（会话点开就能看那一路怎么走的）：', ...trail].join('\n')
}

/**
 * 一发的结论（V4-Iter-242 补）。
 * "判分说过了"与"聚合把它算成过了"是两件事：`maxSteps` 超了以后产物再对也按失败算（§233 的口径）。
 * 2026-10-21 那趟真机第一次读数就撞出这句矛盾——聚合写 pass@1 0%、逐发那行却写"过"，
 * 单独拎任何一句出来都会读错，所以这一句必须同时带两个事实：它实际走了几步、为什么没被计入。
 * 判分原话仍由调用方拼在行尾（那句是判据说的，不是这层该改写的）。
 */
export function describeAttempt(task: EvalTask | undefined, a: AgentEvalAttempt): string {
  if (!a.ran) return '没跑起来'
  const budget = task?.maxSteps
  if (typeof budget === 'number' && typeof a.steps === 'number' && a.steps > budget) {
    return `没过（走了 ${a.steps} 步，超出这条任务 ${budget} 步的预算 ⇒ 按失败算${a.pass ? '；产物本身是对的' : ''}）`
  }
  return a.pass ? '过' : '没过'
}

/**
 * 落盘报告的清单（按时间倒序，最多 20 份）。
 * 每次点开界面都重跑一遍是要花额度的，所以"上次那趟的数字"必须能被读回来。
 */
export function listAgentEvalReports(): AgentEvalReportEntry[] {
  const dir = agentEvalReportDir()
  if (!fs.existsSync(dir)) return []
  const entries: AgentEvalReportEntry[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const abs = path.join(dir, name)
    try {
      const stat = fs.statSync(abs)
      const firstLine = fs.readFileSync(abs, 'utf-8').split('\n')[0] ?? ''
      entries.push({ fileName: name, mtimeMs: stat.mtimeMs, firstLine })
    } catch {
      // 读不到就是列不出：不猜它的内容，也不写一条"空的"进清单
      continue
    }
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20)
}

/**
 * 读一份报告全文。文件名只接受清单里那种形状（不含路径分隔符、必须以 `.md` 结尾）——
 * 这是 `<DATA_DIR>/agent-eval-reports` 的读面，不是任意文件读面。
 */
export function readAgentEvalReport(fileName: string): string {
  if (!isReportFileName(fileName)) throw new Error('EVAL_REPORT_NOT_FOUND:这份报告不在评测目录里')
  const abs = path.join(agentEvalReportDir(), fileName)
  if (!fs.existsSync(abs)) throw new Error('EVAL_REPORT_NOT_FOUND:这份报告不在评测目录里')
  return fs.readFileSync(abs, 'utf-8')
}

function isReportFileName(name: string): boolean {
  return name.endsWith('.md') && !name.includes('/') && !name.includes('\\') && !name.includes('..')
}

/** 起跑前的那道闸：评测会把全局工作目录一头发一头发地切走，普通运行正在跑时不能开这一趟 */
export function assertCanStartEval(): void {
  if (agentEngine.hasActiveRun()) {
    throw new Error('EVAL_RUN_BUSY:有 Agent 运行正在进行，先停下再跑评测')
  }
}
