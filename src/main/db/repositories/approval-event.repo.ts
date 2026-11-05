// 审批审计账本（approval_events，P0-2c-1）
//
// 只记“有人参与决定”的事件：用户批准/拒绝、超时/中止拒绝、会话白名单放行、策略拒绝。
// 自动放行的成功调用不记账（trace 已有工具名/参数/结果，不重复存）。
// 写入失败不抛：由调用方决定 fail-open，并读 getApprovalAuditFailureCount() 做可见提示。

import { randomUUID } from 'node:crypto'
import type { ApprovalEventInput } from '../../../shared/types'
import { dbService } from '../database'
import { createLogger } from '../../logger'

const log = createLogger('approval-events')

export const APPROVAL_RETENTION_DAYS = 180
export const APPROVAL_MAX_ROWS = 100_000
const TRIM_INTERVAL_MS = 60 * 1000

let writeFailures = 0
let lastTrimAt = 0

const clamp = (value: string, max: number): string => (value.length <= max ? value : value.slice(0, max))

export const approvalEventRepo = {
  /**
   * 插入一条审批事件；失败只累计计数并记日志，不抛异常（fail-open）。
   * @returns true = 已落库；false = 写失败（调用方应发可见提示）
   */
  insert(input: ApprovalEventInput): boolean {
    try {
      const db = dbService.getHandle()
      db.prepare(
        `INSERT INTO approval_events (
           id, request_id, conversation_id, assistant_id, step_index, tool_call_id,
           tool_id, tool_name, decision, reason_code, scope, args_digest, args_redacted,
           actor, requested_at, decided_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        clamp(input.requestId, 200),
        clamp(input.conversationId, 200),
        input.assistantId ? clamp(input.assistantId, 200) : null,
        input.stepIndex,
        input.toolCallId ? clamp(input.toolCallId, 200) : null,
        clamp(input.toolId, 200),
        clamp(input.toolName, 200),
        input.decision,
        input.reasonCode ? clamp(input.reasonCode, 200) : null,
        input.scope,
        input.argsDigest ? clamp(input.argsDigest, 200) : null,
        input.argsRedacted,
        clamp(input.actor, 100),
        input.requestedAt,
        input.decidedAt,
        input.decidedAt
      )
      const now = Date.now()
      if (lastTrimAt === 0 || now - lastTrimAt >= TRIM_INTERVAL_MS) {
        trimToLimits(now)
      }
      return true
    } catch (err) {
      writeFailures += 1
      log.warn('审批审计写入失败（不阻断工具执行）', err)
      return false
    }
  },

  count(): number {
    try {
      const row = dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM approval_events').get() as { n: number }
      return row.n
    } catch (err) {
      log.warn('审批审计计数失败', err)
      return 0
    }
  },

  deleteByConversation(conversationId: string): number {
    try {
      return dbService
        .getHandle()
        .prepare('DELETE FROM approval_events WHERE conversation_id = ?')
        .run(conversationId).changes
    } catch (err) {
      log.warn('审批审计按会话删除失败', err)
      return 0
    }
  },

  /** 显式清空：失败**抛出**，由 IPC 层转成 {ok:false}——静默返回 0 会把"没清掉"演成"本来就没有" */
  clearAll(): number {
    return dbService.getHandle().prepare('DELETE FROM approval_events').run().changes
  }
}

/**
 * 上限清理：180 天 或 10 万行，先到先算；SQL 幂等，可重复执行。
 * opts 仅用于测试缩小阈值。
 */
export function trimToLimits(
  now = Date.now(),
  opts: { retentionDays?: number; maxRows?: number } = {}
): { byAge: number; byRows: number } {
  try {
    const db = dbService.getHandle()
    const retentionDays = opts.retentionDays ?? APPROVAL_RETENTION_DAYS
    const maxRows = opts.maxRows ?? APPROVAL_MAX_ROWS
    const byAge = db
      .prepare('DELETE FROM approval_events WHERE created_at < ?')
      .run(now - retentionDays * 24 * 60 * 60 * 1000).changes
    const byRows = db
      .prepare(
        `DELETE FROM approval_events
         WHERE id IN (
           SELECT id FROM approval_events
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?
         )`
      )
      .run(maxRows).changes
    lastTrimAt = now
    return { byAge, byRows }
  } catch (err) {
    log.warn('审批审计上限清理失败', err)
    return { byAge: 0, byRows: 0 }
  }
}

export function getApprovalAuditFailureCount(): number {
  return writeFailures
}

/** 仅供测试重置进程内计数 */
export function resetApprovalAuditStateForTest(): void {
  writeFailures = 0
  lastTrimAt = 0
}
