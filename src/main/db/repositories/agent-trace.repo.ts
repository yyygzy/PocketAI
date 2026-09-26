// Agent Trace 数据访问：记录 Agent 每一步的执行情况，供调试/性能分析使用
import { randomUUID } from 'node:crypto'
import type { AgentRunStats, AgentTraceRecord } from '../../../shared/types'
import { dbService } from '../database'

interface AgentTraceRow {
  id: string
  request_id: string
  conversation_id: string
  step_index: number
  step_type: string
  tool_name: string | null
  duration_ms: number | null
  token_usage: number | null
  status: string
  error: string | null
  created_at: number
}

/** 会话最近一次运行的 requestId（created_at 最新，同毫秒 rowid 兜底）；无记录返回 null */
function latestRequestId(conversationId: string): string | null {
  const row = dbService.getHandle().prepare(
    `SELECT request_id FROM agent_traces
     WHERE conversation_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  ).get(conversationId) as { request_id: string } | undefined
  return row?.request_id ?? null
}

function rowToRecord(row: AgentTraceRow): AgentTraceRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    stepIndex: row.step_index,
    stepType: row.step_type as AgentTraceRecord['stepType'],
    toolName: row.tool_name ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tokenUsage: row.token_usage ?? undefined,
    status: row.status as AgentTraceRecord['status'],
    error: row.error ?? undefined,
    createdAt: row.created_at
  }
}

export const agentTraceRepo = {
  /** 插入一条 trace 记录 */
  insert(rec: Omit<AgentTraceRecord, 'id' | 'createdAt'>): AgentTraceRecord {
    const id = randomUUID()
    const createdAt = Date.now()
    dbService.getHandle().prepare(
      `INSERT INTO agent_traces (id, request_id, conversation_id, step_index, step_type, tool_name, duration_ms, token_usage, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      rec.requestId,
      rec.conversationId,
      rec.stepIndex,
      rec.stepType,
      rec.toolName ?? null,
      rec.durationMs ?? null,
      rec.tokenUsage ?? null,
      rec.status,
      rec.error ?? null,
      createdAt
    )
    return { ...rec, id, createdAt }
  },

  /** 按 requestId 列出所有 trace（按 step_index 升序） */
  listByRequest(requestId: string): AgentTraceRecord[] {
    const rows = dbService.getHandle().prepare(
      'SELECT * FROM agent_traces WHERE request_id = ? ORDER BY step_index ASC'
    ).all(requestId) as AgentTraceRow[]
    return rows.map(rowToRecord)
  },

  /** 按 conversationId 列出最近 N 条 trace */
  listByConversation(conversationId: string, limit = 100): AgentTraceRecord[] {
    const rows = dbService.getHandle().prepare(
      'SELECT * FROM agent_traces WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(conversationId, limit) as AgentTraceRow[]
    return rows.map(rowToRecord)
  },

  /** 统计某次请求的总耗时与平均 token */
  statsByRequest(requestId: string): { totalDurationMs: number; totalTokens: number; stepCount: number } {
    const row = dbService.getHandle().prepare(
      `SELECT COALESCE(SUM(duration_ms), 0) AS total_duration,
              COALESCE(SUM(token_usage), 0) AS total_tokens,
              COUNT(*) AS step_count
       FROM agent_traces WHERE request_id = ?`
    ).get(requestId) as { total_duration: number; total_tokens: number; step_count: number } | undefined
    return {
      totalDurationMs: row?.total_duration ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      stepCount: row?.step_count ?? 0
    }
  },

  /** 会话最近一次运行的汇总统计；无 trace 返回 null */
  latestStatsByConversation(conversationId: string): AgentRunStats | null {
    const requestId = latestRequestId(conversationId)
    if (!requestId) return null
    const stats = agentTraceRepo.statsByRequest(requestId)
    return stats.stepCount === 0 ? null : stats
  },

  /** 会话最近一次运行的分步明细（按 step_index 升序）；无 trace 返回空数组 */
  latestTracesByConversation(conversationId: string): AgentTraceRecord[] {
    const requestId = latestRequestId(conversationId)
    if (!requestId) return []
    const rows = dbService.getHandle().prepare(
      'SELECT * FROM agent_traces WHERE request_id = ? ORDER BY step_index ASC, rowid ASC'
    ).all(requestId) as AgentTraceRow[]
    return rows.map(rowToRecord)
  },

  /** 清理指定 requestId 的 trace */
  deleteByRequest(requestId: string): void {
    dbService.getHandle().prepare('DELETE FROM agent_traces WHERE request_id = ?').run(requestId)
  }
}
