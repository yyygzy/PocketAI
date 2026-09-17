// Message 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { MessageRecord, MessageRole, MessageStatus } from '../../../shared/types'

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
}

function rowToRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content ?? '',
    provider: row.provider,
    model: row.model,
    status: (row.status as MessageStatus) ?? 'done',
    parentId: row.parent_id,
    createdAt: row.created_at
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
  }): MessageRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now
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
      createdAt: now
    }
  },

  updateContent(id: string, content: string, status: MessageStatus): void {
    dbService
      .getHandle()
      .prepare('UPDATE messages SET content=?, status=? WHERE id=?')
      .run(content, status, id)
  }
}
