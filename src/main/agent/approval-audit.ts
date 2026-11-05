// 审批事件写入的唯一出口：把“决定 + 上下文”拼成 approval_events 行。
//
// fail-open：写失败不阻断工具执行，但本次进程内只广播一次可见告警；
// 失败次数由 repo 累计，数据健康面板可读。

import { IPC } from '../../shared/types'
import type {
  ApprovalAuditContext,
  ApprovalDecision,
  ApprovalScope,
  ApprovalAuditWarnEvent
} from '../../shared/types'
import {
  approvalEventRepo,
  getApprovalAuditFailureCount
} from '../db/repositories/approval-event.repo'
import { redactArgsForAudit } from '../security/audit-redact'

let warnEmitted = false

export interface RecordApprovalInput {
  requestId: string
  conversationId: string
  toolName: string
  decision: ApprovalDecision
  reasonCode: string | null
  scope: ApprovalScope
  /** 复用 toolArgsFingerprint 的结果，由调用方传入，避免与 tool-approval 形成循环依赖 */
  argsDigest: string
  argsJson?: string | null
  context?: ApprovalAuditContext
  emit?: (channel: string, payload: unknown) => void
}

/** 写一条审批事件；返回 false 表示审计未落库（工具仍按原决定执行） */
export function recordApprovalDecision(input: RecordApprovalInput): boolean {
  const ctx = input.context
  const requestedAt = ctx?.requestedAt ?? Date.now()
  const decidedAt = Date.now()
  const ok = approvalEventRepo.insert({
    requestId: input.requestId,
    conversationId: input.conversationId,
    assistantId: ctx?.assistantId ?? null,
    stepIndex: ctx?.stepIndex ?? null,
    toolCallId: ctx?.toolCallId ?? null,
    toolId: ctx?.toolId ?? input.toolName,
    toolName: input.toolName,
    decision: input.decision,
    reasonCode: input.reasonCode,
    scope: input.scope,
    argsDigest: input.argsDigest,
    argsRedacted: redactArgsForAudit(input.argsJson),
    actor: 'local_user',
    requestedAt,
    decidedAt
  })

  // 只在真的发出去了才置位：无人值守那条路没有渲染端（emit 不存在/已销毁），
  // 否则第一次失败会把"本进程只提示一次"的名额白白用掉，桌面端永远看不到提示。
  if (!ok && !warnEmitted && input.emit) {
    warnEmitted = true
    input.emit(IPC.AGENT_APPROVAL_AUDIT_WARN_EVENT, {
      at: Date.now(),
      failures: getApprovalAuditFailureCount()
    } satisfies ApprovalAuditWarnEvent)
  }
  return ok
}

/** 仅测试：允许下一条失败再次广播 */
export function resetApprovalAuditWarnForTest(): void {
  warnEmitted = false
}
