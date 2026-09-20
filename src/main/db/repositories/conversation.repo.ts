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
  /** 列出会话；assistantId 给定时按助手归集；isAgent 控制是否只列 Agent 会话 */
  list(assistantId?: string, isAgent?: boolean): ConversationRecord[] {
    const conds: string[] = []
    const vals: unknown[] = []
    if (assistantId === 'asst-default') {
      conds.push("(assistant_id = 'asst-default' OR assistant_id IS NULL)")
    } else if (assistantId) {
      conds.push('assistant_id = ?')
      vals.push(assistantId)
    }
    if (isAgent === true) {
      conds.push("model LIKE 'agent:%'")
    } else if (isAgent === false) {
      conds.push("(model NOT LIKE 'agent:%' OR model IS NULL)")
    }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : ''
    const rows = dbService
      .getHandle()
      .prepare(`SELECT * FROM conversations${where} ORDER BY updated_at DESC`)
      .all(...vals) as ConversationRow[]
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
    const tx = db.transaction(() => {
      // 级联删除消息（FTS 触发器自动同步）
      db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id)
      db.prepare('DELETE FROM messages_fts WHERE conversation_id=?').run(id)
      db.prepare('DELETE FROM conversations WHERE id=?').run(id)
    })
    tx()
  },

  /**
   * 消息分支：复制源会话中截至 upToMessageId（含该消息）的全部消息到新会话。
   * - 消息按 created_at/rowid 线性截取前缀（含 user/assistant/tool/system）
   * - 全部消息生成新 UUID，parent_id 按 oldId→newId 映射重写
   * - 保留 tool_calls / attachments / created_at；FTS 由触发器自动同步
   */
  fork(srcConversationId: string, upToMessageId: string): ConversationRecord {
    const db = dbService.getHandle()
    const src = this.get(srcConversationId)
    if (!src) throw new Error('源会话不存在')

    const tx = db.transaction((): ConversationRecord => {
      const all = db
        .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC')
        .all(srcConversationId) as Array<{
          id: string
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
        }>
      const cutIdx = all.findIndex((m) => m.id === upToMessageId)
      if (cutIdx === -1) throw new Error('分支起点消息不存在')
      const subset = all.slice(0, cutIdx + 1)

      const now = Date.now()
      const newConvId = randomUUID()
      db.prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, params, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?)`
      ).run(
        newConvId,
        src.assistantId,
        `${src.title || '新对话'} (分支)`,
        src.modelLabel,
        now,
        now
      )

      const idMap = new Map<string, string>()
      const insertMsg = db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at, tool_calls, attachments, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const m of subset) {
        const newMsgId = randomUUID()
        idMap.set(m.id, newMsgId)
        const newParent = m.parent_id ? idMap.get(m.parent_id) ?? null : null
        insertMsg.run(
          newMsgId,
          newConvId,
          m.role,
          m.content,
          m.provider,
          m.model,
          m.status ?? 'done',
          newParent,
          m.created_at,
          m.tool_calls ?? null,
          m.attachments ?? null,
          m.batch_id ?? null
        )
      }
      return this.get(newConvId)!
    })
    return tx()
  }
}
