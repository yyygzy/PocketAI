// 工具调用人工审批服务（shell_exec 等 confirm 级工具）
//
// 主流程：引擎判定需确认 → 命中会话级「总是允许」白名单则直接放行；
// 否则 createApproval() 广播审批事件给渲染端并等待；
// 渲染端弹窗应答（可勾选本次会话总是允许）→ ipc 调 resolveApproval(id, bool, alwaysAllow) 放行/拒绝。
// 5 分钟无应答或 Agent 中止 → 自动按「拒绝」处理，防止 Promise 泄漏与悬空审批。
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/types'
import type { ToolApprovalRequestEvent } from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

interface PendingApproval {
  settle: (approved: boolean) => void
  timer: NodeJS.Timeout
  conversationId?: string
  toolName?: string
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
/** 单会话「总是允许」的工具数上限，防无限增长 */
const SESSION_ALLOW_MAX = 50

const pending = new Map<string, PendingApproval>()
/** 会话级白名单：conversationId → 已允许的 toolName 集合（不落库，进程生命周期） */
const sessionAllows = new Map<string, Set<string>>()

function markSessionAllow(conversationId: string | undefined, toolName: string | undefined): void {
  if (!conversationId || !toolName) return
  let set = sessionAllows.get(conversationId)
  if (!set) {
    set = new Set()
    sessionAllows.set(conversationId, set)
  }
  // FIFO 淘汰：超上限时删最旧（Set 迭代按插入序）
  if (set.size >= SESSION_ALLOW_MAX && !set.has(toolName)) {
    const oldest = set.values().next().value
    if (oldest) set.delete(oldest)
  }
  set.add(toolName)
}

function isSessionAllowed(conversationId: string | undefined, toolName: string | undefined): boolean {
  if (!conversationId || !toolName) return false
  return sessionAllows.get(conversationId)?.has(toolName) ?? false
}

/** 会话删除/切换时清空白名单，避免残留 */
export function clearSessionAllow(conversationId: string): void {
  sessionAllows.delete(conversationId)
}

/**
 * 发起一次审批：先查会话级白名单（命中则直接放行），否则广播事件并返回用户应答 Promise。
 * @param req 除 approvalId 外的审批内容
 * @param emit 引擎注入的事件广播函数
 * @param signal Agent 中止信号（abort 时按拒绝处理）
 */
export function createApproval(
  req: Omit<ToolApprovalRequestEvent, 'approvalId'>,
  emit: EmitFn,
  signal?: AbortSignal
): Promise<boolean> {
  // 会话级「总是允许」：同一会话内同工具名不再弹窗
  if (isSessionAllowed(req.conversationId, req.toolName)) {
    return Promise.resolve(true)
  }

  const approvalId = randomUUID()

  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(entry.timer)
      signal?.removeEventListener('abort', onAbort)
      pending.delete(approvalId)
    }
    const settle = (approved: boolean) => {
      if (!pending.has(approvalId)) return // 已超时/已应答：幂等忽略
      cleanup()
      resolve(approved)
    }

    const onAbort = () => settle(false)

    // 已中止：不登记 pending、不建定时器，直接按拒绝返回
    if (signal?.aborted) {
      resolve(false)
      return
    }

    const entry: PendingApproval = {
      settle,
      timer: setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS),
      conversationId: req.conversationId,
      toolName: req.toolName
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    pending.set(approvalId, entry)

    const event: ToolApprovalRequestEvent = { ...req, approvalId }
    emit(IPC.AGENT_TOOL_APPROVAL_EVENT, event)
  })
}

/**
 * 渲染端应答入口；返回是否匹配到待审批项（幂等：重复应答返回 false）。
 * @param alwaysAllow 勾选「本次会话总是允许」时，后续同会话同工具直接放行
 */
export function resolveApproval(
  approvalId: string,
  approved: boolean,
  alwaysAllow = false
): boolean {
  const entry = pending.get(approvalId)
  if (!entry) return false
  if (approved && alwaysAllow) markSessionAllow(entry.conversationId, entry.toolName)
  entry.settle(approved)
  return true
}

/** 测试用：重置全部状态 */
export function resetApprovalStateForTest(): void {
  pending.forEach((e) => {
    clearTimeout(e.timer)
  })
  pending.clear()
  sessionAllows.clear()
}
