// Conversation 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { ConversationRecord } from '../../../shared/types'

interface ConversationRow {
  id: string
  assistant_id: string | null
  title: string | null
  model: string | null
  params: string | null
  status: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title ?? '新对话',
    modelLabel: row.model,
    status: row.status ?? 'idle',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const conversationRepo = {
  /** 列出会话；assistantId 给定时按助手归集（默认助手含历史 NULL 数据） */
  list(assistantId?: string): ConversationRecord[] {
    let rows: ConversationRow[]
    if (assistantId === 'asst-default') {
      rows = dbService
        .getHandle()
        .prepare(
          `SELECT * FROM conversations
           WHERE assistant_id = 'asst-default' OR assistant_id IS NULL
           ORDER BY updated_at DESC`
        )
        .all() as ConversationRow[]
    } else if (assistantId) {
      rows = dbService
        .getHandle()
        .prepare(
          `SELECT * FROM conversations WHERE assistant_id=? ORDER BY updated_at DESC`
        )
        .all(assistantId) as ConversationRow[]
    } else {
      rows = dbService
        .getHandle()
        .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
        .all() as ConversationRow[]
    }
    return rows.map(rowToRecord)
  },

  get(id: string): ConversationRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined
    return row ? rowToRecord(row) : null
  },

  create(input: { assistantId?: string | null; title?: string; modelLabel?: string } = {}): ConversationRecord {
    const now = Date.now()
    const id = randomUUID()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, params, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?)`
      )
      .run(id, input.assistantId ?? null, input.title ?? '新对话', input.modelLabel ?? null, now, now)
    return this.get(id)!
  },

  rename(id: string, title: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET title=?, updated_at=? WHERE id=?')
      .run(title, Date.now(), id)
  },

  touch(id: string, patch: { modelLabel?: string; status?: string } = {}): void {
    const sets = ['updated_at=?']
    const vals: unknown[] = [Date.now()]
    if (patch.modelLabel !== undefined) {
      sets.push('model=?')
      vals.push(patch.modelLabel)
    }
    if (patch.status !== undefined) {
      sets.push('status=?')
      vals.push(patch.status)
    }
    vals.push(id)
    dbService
      .getHandle()
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id=?`)
      .run(...vals)
  },

  delete(id: string): void {
    const db = dbService.getHandle()
    db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id)
    db.prepare('DELETE FROM conversations WHERE id=?').run(id)
  }
}
