// 旁路 LLM 调用计费事件数据访问（v71 usage_events）
// 与 messages.usage 分开存：旁路调用不是对话消息，混写会污染逐轮明细与按消息跳转。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { UsageSideCallKind, UsageStats } from '../../../shared/types'

export interface UsageEventRow {
  id: string
  conversation_id: string | null
  provider: string | null
  model: string | null
  usage: string
  created_at: number
  kind: string
}

export interface UsageEventDetailRow extends UsageEventRow {
  conversation_title: string | null
  assistant_id: string | null
  assistant_name: string | null
}

export interface UsageEventInput {
  conversationId?: string | null
  requestId?: string | null
  stepIndex?: number | null
  kind: UsageSideCallKind
  providerId: string | null
  model: string | null
  usage: UsageStats
}

export const usageEventRepo = {
  insert(input: UsageEventInput): void {
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO usage_events (id, conversation_id, request_id, step_index, kind, provider, model, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.conversationId ?? null,
        input.requestId ?? null,
        input.stepIndex ?? null,
        input.kind,
        input.providerId,
        input.model,
        JSON.stringify(input.usage),
        Date.now()
      )
  },

  /** 时间范围内的事件行（汇总/预算用；字段与 messages 聚合行同形） */
  listSince(sinceTs: number): UsageEventRow[] {
    return dbService
      .getHandle()
      .prepare(
        `SELECT id, conversation_id, provider, model, usage, created_at, kind
         FROM usage_events WHERE created_at >= ? ORDER BY created_at ASC`
      )
      .all(sinceTs) as UsageEventRow[]
  },

  /** 按会话归属的事件行（排行用；NULL/已删会话由聚合侧归入「未知会话」，不丢账） */
  listConversationRowsSince(sinceTs: number): {
    conversation_id: string | null
    title: string | null
    provider: string | null
    model: string | null
    usage: string
    created_at: number
  }[] {
    return dbService
      .getHandle()
      .prepare(
        `SELECT e.conversation_id, c.title, e.provider, e.model, e.usage, e.created_at
         FROM usage_events e
         LEFT JOIN conversations c ON c.id = e.conversation_id
         WHERE e.created_at >= ? ORDER BY e.created_at ASC`
      )
      .all(sinceTs) as {
        conversation_id: string | null
        title: string | null
        provider: string | null
        model: string | null
        usage: string
        created_at: number
      }[]
  },

  /** 按助手归属的事件行（会话 LEFT JOIN 助手；NULL 助手由聚合侧归入「未知助手」） */
  listAssistantRowsSince(sinceTs: number): {
    provider: string | null
    model: string | null
    usage: string
    created_at: number
    assistant_id: string | null
    name: string | null
  }[] {
    return dbService
      .getHandle()
      .prepare(
        `SELECT e.provider, e.model, e.usage, e.created_at, c.assistant_id, a.name
         FROM usage_events e
         LEFT JOIN conversations c ON c.id = e.conversation_id
         LEFT JOIN assistants a ON a.id = c.assistant_id
         WHERE e.created_at >= ? ORDER BY e.created_at ASC`
      )
      .all(sinceTs) as {
        provider: string | null
        model: string | null
        usage: string
        created_at: number
        assistant_id: string | null
        name: string | null
      }[]
  },

  /** 行级明细：LEFT JOIN 会话/助手带出标题与名称；scopeSql 由调用方按别名 c 拼装 */
  listDetailSince(
    sinceTs: number,
    limit: number,
    scopeSql = '',
    scopeVals: unknown[] = []
  ): UsageEventDetailRow[] {
    return dbService
      .getHandle()
      .prepare(
        `SELECT e.id, e.conversation_id, e.provider, e.model, e.usage, e.created_at, e.kind,
                c.title AS conversation_title, c.assistant_id, a.name AS assistant_name
         FROM usage_events e
         LEFT JOIN conversations c ON c.id = e.conversation_id
         LEFT JOIN assistants a ON a.id = c.assistant_id
         WHERE e.created_at >= ?${scopeSql}
         ORDER BY e.created_at DESC
         LIMIT ?`
      )
      .all(sinceTs, ...scopeVals, limit) as UsageEventDetailRow[]
  },

  /** 历史出现过的 provider/模型（单价编辑器清单；与 messages 同口径） */
  listDistinctModels(limit: number): { provider: string; model: string; lastUsedAt: number }[] {
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT provider, model, MAX(created_at) AS last_used_at
         FROM usage_events
         WHERE provider IS NOT NULL AND model IS NOT NULL
         GROUP BY provider, model
         ORDER BY last_used_at DESC
         LIMIT ?`
      )
      .all(limit) as { provider: string; model: string; last_used_at: number }[]
    return rows.map((r) => ({ provider: r.provider, model: r.model, lastUsedAt: r.last_used_at }))
  }
}
