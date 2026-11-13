// P0-5 dry-run 回放执行
//
// 「回放」在这里是**按账本重建**，不是重跑模型：判据要求回放全程零网络出口，
// 一旦重新请求模型就必然出网（本地模型也算一条网络调用），所以回放只读
// `agent_traces` 与 `messages`，把当时发生了什么原样摊开，不产生任何新的执行。
//
// 工具结果的读取口径与 `trace-replay.ts` 一致：**优先 `messages.content`**（权威原文），
// 没有引用列时才退回 trace 里的诊断副本；卸载 `.txt` 只是缓存，这里不读它。
// 这样 `expired`（文件被淘汰）不会把"消息还在"误判成原文丢失。
import type { AgentTraceRecord } from '../../shared/types'
import { agentTraceRepo } from '../db/repositories/agent-trace.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { createLogger } from '../logger'
import { splitTraceRefList } from './trace-replay'
import { runWithToolsDisabled } from './dry-run-scope'

const log = createLogger('dry-run-replay')

export interface DryRunReplayDeps {
  listSteps(requestId: string): AgentTraceRecord[]
  /** 读 `messages.content`；行不在返回 null（不是空串语义） */
  readMessageContent(messageId: string): string | null
}

/** 一条工具调用的回放结果（只有 `messages` 来源能按调用拆开） */
export interface DryRunReplayedCall {
  toolCallId?: string
  name?: string
  isError: boolean
  content: string
}

export interface DryRunReplayedOutput {
  /**
   * `messages`：权威原文（可能含未脱敏内容，仅内存中回放，不落盘）；
   * `trace`：trace 的诊断副本（已脱敏、可能被截断），只在这一步没有引用列时使用。
   */
  source: 'messages' | 'trace'
  calls?: DryRunReplayedCall[]
  /** trace 来源的整步聚合串（多调用按换行拼在一起，无法可靠拆开） */
  text?: string
}

export interface DryRunReplayedStep {
  stepIndex: number
  stepType: AgentTraceRecord['stepType']
  toolName?: string
  status: AgentTraceRecord['status']
  error?: string
  /** 只有 `tools` 步有输出 */
  output?: DryRunReplayedOutput
  /**
   * `tools` 步无法还原输出时的原因：
   * `expired`＝有引用记录但消息行已不在；`never_stored`＝从来没有可读副本。
   */
  missing?: 'expired' | 'never_stored'
}

export interface DryRunReplayReport {
  requestId: string
  conversationId?: string
  steps: DryRunReplayedStep[]
  /** 恒为 0：回放不执行工具；>0 说明有代码在回放里试图执行（被 scope 闸拦下） */
  toolAttemptsBlocked: number
  /** trace 读不出来（库被关／表缺失）：判定不可用，不硬凑成空运行 */
  unavailable?: boolean
  /** `unavailable` 时的原因（诊断用，不上屏） */
  error?: string
}

const defaultDeps: DryRunReplayDeps = {
  listSteps: (requestId) => agentTraceRepo.listByRequest(requestId),
  readMessageContent: (messageId) => messageRepo.getById(messageId)?.content ?? null
}

/** 解析 tool 消息的 JSON 信封；解析失败就把它当成纯文本结果，不丢内容 */
function parseToolMessage(raw: string): Omit<DryRunReplayedCall, 'isError'> & { isError?: boolean } {
  try {
    const parsed = JSON.parse(raw) as {
      toolCallId?: unknown
      name?: unknown
      content?: unknown
      isError?: unknown
    }
    return {
      toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      content: typeof parsed.content === 'string' ? parsed.content : raw,
      isError: parsed.isError === true
    }
  } catch {
    return { content: raw }
  }
}

/**
 * 还原一步 `tools` 的输出。
 *
 * 顺序是刻意的：先按 `messageId` 读原文；只有引用列全空时才用 `toolResult`。
 * 引用列非空却读不到行 ⇒ `expired`，此时**不回退**到被截断的 trace 文本冒充原文，
 * 否则回放会静默地少一段内容却看起来完整。
 */
function replayToolOutput(
  rec: AgentTraceRecord,
  deps: DryRunReplayDeps
): Pick<DryRunReplayedStep, 'output' | 'missing'> {
  const ids = splitTraceRefList(rec.messageId).filter((id) => id !== '')
  if (ids.length > 0) {
    const calls: DryRunReplayedCall[] = []
    let missingAny = false
    for (const id of ids) {
      const raw = deps.readMessageContent(id)
      if (raw === null) {
        missingAny = true
        continue
      }
      const parsed = parseToolMessage(raw)
      calls.push({
        toolCallId: parsed.toolCallId,
        name: parsed.name,
        isError: parsed.isError === true,
        content: parsed.content
      })
    }
    return {
      output: { source: 'messages', calls },
      ...(missingAny ? { missing: 'expired' as const } : {})
    }
  }

  if (rec.toolResult !== undefined && rec.toolResult !== '') {
    return { output: { source: 'trace', text: rec.toolResult } }
  }
  return { missing: 'never_stored' }
}

function toReplayedStep(rec: AgentTraceRecord, deps: DryRunReplayDeps): DryRunReplayedStep {
  const step: DryRunReplayedStep = {
    stepIndex: rec.stepIndex,
    stepType: rec.stepType,
    status: rec.status,
    ...(rec.toolName !== undefined ? { toolName: rec.toolName } : {}),
    ...(rec.error !== undefined ? { error: rec.error } : {})
  }
  if (rec.stepType !== 'tools') return step
  return { ...step, ...replayToolOutput(rec, deps) }
}

/**
 * 回放一次运行（dry-run）。
 *
 * 全程在「工具禁用」作用域内：任何绕回 `toolRegistry.execute` 的调用都会被硬拒并计入
 * `toolAttemptsBlocked`；正常情况下它恒为 0。本函数自身只读 DB，不写文件、不联网。
 */
export async function replayTraceDryRun(
  requestId: string,
  deps: DryRunReplayDeps = defaultDeps
): Promise<DryRunReplayReport> {
  return runWithToolsDisabled(async (scope) => {
    let records: AgentTraceRecord[]
    try {
      records = deps.listSteps(requestId)
    } catch (e) {
      log.warn(`回放读取 trace 失败（判定不可用）: ${(e as Error).message}`)
      return {
        requestId,
        steps: [],
        toolAttemptsBlocked: scope.blockedAttempts,
        unavailable: true,
        error: (e as Error).message
      }
    }
    return {
      requestId,
      conversationId: records[0]?.conversationId,
      steps: records.map((rec) => toReplayedStep(rec, deps)),
      toolAttemptsBlocked: scope.blockedAttempts
    }
  })
}
