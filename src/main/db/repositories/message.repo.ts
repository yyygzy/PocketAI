// Message 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { MessageRecord, MessageRole, MessageStatus, ChatAttachment } from '../../../shared/types'

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content: string | null
  provider: string | null
  model: string | null
  status: string | null
  parent_id: string | null
  created_at: number
  tool_calls: string | null
  attachments: string | null
  batch_id: string | null
  sources: string | null
}

export function rowToRecord(row: MessageRow): MessageRecord {
  let attachments: ChatAttachment[] | undefined
  if (row.attachments) {
    try { attachments = JSON.parse(row.attachments) } catch { /* ignore */ }
  }
  let sources: MessageRecord['sources'] = undefined
  if (row.sources) {
    try { sources = JSON.parse(row.sources) } catch { /* ignore */ }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content ?? '',
    provider: row.provider,
    model: row.model,
    status: (row.status as MessageStatus) ?? 'done',
    parentId: row.parent_id,
    createdAt: row.created_at,
    toolCalls: row.tool_calls ?? null,
    attachments,
    batchId: row.batch_id,
    sources
  }
}

export const messageRepo = {
  listByConversation(conversationId: string): MessageRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC')
      .all(conversationId) as MessageRow[]
    return rows.map(rowToRecord)
  },

  getById(id: string): MessageRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM messages WHERE id=?')
      .get(id) as MessageRow | undefined
    return row ? rowToRecord(row) : null
  },

  insert(input: {
    conversationId: string
    role: MessageRole
    content?: string
    provider?: string | null
    model?: string | null
    status?: MessageStatus
    parentId?: string | null
    toolCalls?: string | null
    attachments?: ChatAttachment[]
    batchId?: string | null
  }): MessageRecord {
    const id = randomUUID()
    const now = Date.now()
    const attachmentsJson = input.attachments && input.attachments.length > 0
      ? JSON.stringify(input.attachments)
      : null
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at, tool_calls, attachments, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.role,
        input.content ?? '',
        input.provider ?? null,
        input.model ?? null,
        input.status ?? 'done',
        input.parentId ?? null,
        now,
        input.toolCalls ?? null,
        attachmentsJson,
        input.batchId ?? null
      )
    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content ?? '',
      provider: input.provider ?? null,
      model: input.model ?? null,
      status: input.status ?? 'done',
      parentId: input.parentId ?? null,
      createdAt: now,
      toolCalls: input.toolCalls ?? null,
      attachments: input.attachments,
      batchId: input.batchId ?? null
    }
  },

  updateContent(id: string, content: string, status: MessageStatus, sources?: MessageRecord['sources']): void {
    const sourcesJson = sources && sources.length > 0 ? JSON.stringify(sources) : null
    dbService
      .getHandle()
      .prepare('UPDATE messages SET content=?, status=?, sources=? WHERE id=?')
      .run(content, status, sourcesJson, id)
  },

  updateToolCalls(id: string, toolCalls: string | null): void {
    dbService
      .getHandle()
      .prepare('UPDATE messages SET tool_calls=? WHERE id=?')
      .run(toolCalls, id)
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM messages WHERE id=?').run(id)
  },

  /**
   * 截断重跑：删除目标消息及其在同一会话中之后插入的所有消息。
   * 以 rowid（插入顺序）为界，比 created_at 同毫秒歧义更精确；
   * 不影响其他会话。返回删除行数，目标不存在时返回 0。
   * FTS 索引由 messages_ad DELETE 触发器联动清理。
   */
  truncateFrom(messageId: string): number {
    const handle = dbService.getHandle()
    const target = handle
      .prepare('SELECT rowid AS rid, conversation_id FROM messages WHERE id=?')
      .get(messageId) as { rid: number; conversation_id: string } | undefined
    if (!target) return 0
    const res = handle
      .prepare('DELETE FROM messages WHERE conversation_id=? AND rowid>=?')
      .run(target.conversation_id, target.rid)
    return res.changes
  },

  /** 更新用户消息内容（编辑后重发） */
  updateUserContent(id: string, content: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE messages SET content=? WHERE id=?')
      .run(content, id)
  }
}
