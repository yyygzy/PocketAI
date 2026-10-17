// Agent Trace 数据访问：记录 Agent 每一步的执行情况，供调试/性能分析使用
import { randomUUID } from 'node:crypto'
import type { AgentRunStats, AgentSessionStats, AgentTraceRecord } from '../../../shared/types'
import { dbService } from '../database'
import { createLogger } from '../../logger'

const log = createLogger('agent-trace')

/** agent_traces 表是否可用（缺失时只记一次 warn，后续静默降级） */
let tableMissingWarned = false

function isTableMissingError(e: unknown): boolean {
  return e instanceof Error && /no such table: agent_traces/.test(e.message)
}

function warnTableMissingOnce(): void {
  if (!tableMissingWarned) {
    tableMissingWarned = true
    log.warn('agent_traces 表缺失，统计/明细功能降级为空（下次启动 migration v24 会补建）')
  }
}

interface AgentTraceRow {
  id: string
  request_id: string
  conversation_id: string
  /** v48：控制器那一次 request；NULL=这一行不是委派出来的子运行 */
  parent_request_id?: string | null
  step_index: number
  step_type: string
  tool_name: string | null
  duration_ms: number | null
  token_usage: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  status: string
  error: string | null
  created_at: number
}

/** 会话最近一次运行的 requestId（created_at 最新，同毫秒 rowid 兜底）；无记录返回 null */
function latestRequestId(conversationId: string): string | null {
  try {
    const row = dbService.getHandle().prepare(
      `SELECT request_id FROM agent_traces
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`
    ).get(conversationId) as { request_id: string } | undefined
    return row?.request_id ?? null
  } catch (e) {
    if (isTableMissingError(e)) {
      warnTableMissingOnce()
      return null
    }
    throw e
  }
}

function rowToRecord(row: AgentTraceRow): AgentTraceRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    parentRequestId: row.parent_request_id ?? null,
    stepIndex: row.step_index,
    stepType: row.step_type as AgentTraceRecord['stepType'],
    toolName: row.tool_name ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tokenUsage: row.token_usage ?? undefined,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
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
      `INSERT INTO agent_traces (id, request_id, conversation_id, parent_request_id, step_index, step_type, tool_name, duration_ms, token_usage, prompt_tokens, completion_tokens, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      rec.requestId,
      rec.conversationId,
      rec.parentRequestId ?? null,
      rec.stepIndex,
      rec.stepType,
      rec.toolName ?? null,
      rec.durationMs ?? null,
      rec.tokenUsage ?? null,
      rec.promptTokens ?? null,
      rec.completionTokens ?? null,
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

  /**
   * 一次运行的汇总：**token 按整棵编排树算，步数与耗时只算主干**（V4-Iter-163，用户选定口径）。
   *
   * 这条不对称是刻意的，两处都有实测依据：
   *  · 耗时**不许**加子 run——父那一步 `tools:delegate_task` 的 `duration_ms` 物理上已经包住了整段子运行
   *    （162 实测：父 3 步 33.3 + 38.8 + 21.9 = 94.0s 就是全程墙钟，而子的 19.2s 就藏在那 38.8s 里；再加一遍会虚报成 113s）。
   *  · token **必须**加子 run——子的每一步挂在子会话自己那次 request 上，只按 `request_id = ?` 聚合就会少报
   *    （162 实测：界面写 6,736，这趟编排实际烧了 9,833，差的正是云端那台子代理的 3,097）。
   * v48 加 `parent_request_id` 时注释写的是"成本按整棵编排树聚合就靠这一列"，但列一直在写、没人读 ⇒ 本轮接上。
   *
   * 一层就够：子级工具面被 `childToolSurface()` 摘掉了 `delegate_task`，套娃在结构上不存在，所以这里
   * 不需要递归求和（`WHERE request_id = ? OR parent_request_id = ?` 就是整棵树）。
   *
   * `childRuns` 为 0 时给 **undefined 而不是 0**：界面上"有没有子代理"要一句话说得清，
   * 而既有那些逐键 `toEqual` 的断言不该被一个新字段打破（vitest 的比较里 undefined 键视同不存在）。
   */
  statsByRequest(requestId: string): AgentRunStats {
    const row = dbService.getHandle().prepare(
      `SELECT COALESCE(SUM(CASE WHEN request_id = ? THEN duration_ms ELSE 0 END), 0) AS total_duration,
              COALESCE(SUM(token_usage), 0) AS total_tokens,
              COALESCE(SUM(CASE WHEN request_id = ? THEN 1 ELSE 0 END), 0) AS step_count,
              COUNT(DISTINCT CASE WHEN request_id <> ? THEN request_id END) AS child_runs
       FROM agent_traces WHERE request_id = ? OR parent_request_id = ?`
    ).get(requestId, requestId, requestId, requestId, requestId) as {
      total_duration: number; total_tokens: number; step_count: number; child_runs: number
    } | undefined
    return {
      totalDurationMs: row?.total_duration ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      stepCount: row?.step_count ?? 0,
      ...(row && row.child_runs > 0 ? { childRuns: row.child_runs } : {})
    }
  },

  /** 会话最近一次运行的汇总统计；无 trace 返回 null */
  latestStatsByConversation(conversationId: string): AgentRunStats | null {
    const requestId = latestRequestId(conversationId)
    if (!requestId) return null
    const stats = agentTraceRepo.statsByRequest(requestId)
    return stats.stepCount === 0 ? null : stats
  },

  /**
   * 会话级累计统计（跨全部运行）。口径与 `statsByRequest` 同一条：**主干算次数与耗时，token 含子 run**。
   * 主干那半边用 `conversation_id = ?` 认而不是 `parent_request_id IS NULL`：本会话自己的每一步都属于主干
   * （只有子运行的步才带父 id），这样**直接把一个子会话进来查时行为不变**（143 那条"子会话账本独立可见"
   * 的用例还在，它查的就是子会话）。
   * 没有索引可依赖：`agent_traces` 从来没给 `request_id`/`parent_request_id` 建过索引，
   * 改前那句 `WHERE request_id = ?` 本来就是全表扫 ⇒ 这一版没有引入新的量级（台账里记着"要加索引是另一件事"）。
   */
  sessionStatsByConversation(conversationId: string): AgentSessionStats | null {
    try {
      const row = dbService.getHandle().prepare(
        `SELECT COALESCE(SUM(CASE WHEN conversation_id = ? THEN duration_ms ELSE 0 END), 0) AS total_duration,
                COALESCE(SUM(token_usage), 0) AS total_tokens,
                COUNT(DISTINCT CASE WHEN conversation_id = ? THEN request_id END) AS run_count,
                COUNT(DISTINCT CASE WHEN conversation_id <> ? THEN request_id END) AS child_runs
         FROM agent_traces
         WHERE conversation_id = ?
            OR parent_request_id IN (SELECT request_id FROM agent_traces WHERE conversation_id = ?)`
      ).get(conversationId, conversationId, conversationId, conversationId, conversationId) as {
        run_count: number; total_duration: number; total_tokens: number; child_runs: number
      } | undefined
      if (!row || row.run_count === 0) return null
      return {
        runCount: row.run_count,
        totalDurationMs: row.total_duration,
        totalTokens: row.total_tokens,
        ...(row.child_runs > 0 ? { childRuns: row.child_runs } : {})
      }
    } catch (e) {
      if (isTableMissingError(e)) {
        warnTableMissingOnce()
        return null
      }
      throw e
    }
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

  /**
   * 清理指定 requestId 的 trace。
   *
   * **全仓只有两条路径会删 trace**：这里（「重新运行」把上一次那几步清掉）与
   * `conversationRepo.delete()`（166 补的，按子树连带删）。
   * 刻意**没有**"清扫孤儿行"的迁移：166 之前删会话会留下没有主人的 trace，那些行按
   * 2026-10-17 用户定的口径**保留**——`agent_traces` 是成本审计账本（`messages` 删了就没有
   * 任何地方能还原"那次编排烧了多少 token"，用量明细本来就是 messages 的派生视图），
   * 所以"看见孤儿行就想收一收"是错的方向。要改这个口径先改这段注释与台账 V4-Iter-167。
   */
  deleteByRequest(requestId: string): void {
    dbService.getHandle().prepare('DELETE FROM agent_traces WHERE request_id = ?').run(requestId)
  }
}
