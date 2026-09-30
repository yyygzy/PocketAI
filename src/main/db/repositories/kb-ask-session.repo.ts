// KB 问答会话数据访问
//
// kb_ask_sessions 表结构（v33 迁移）：
//   id TEXT PK, kb_id TEXT, title TEXT, messages_json TEXT,
//   provider_id TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
// 一个问答会话一行，消息体（含引用来源）JSON 单列存储；
// 列表按库过滤、更新时间倒序，返回瘦身元数据不含消息正文。
import { dbService } from '../database'
import { parseKbAskMessages } from '../../../shared/kb-ask-session'
import type { KbAskSessionMeta, KbAskSessionRecord } from '../../../shared/types'

interface SessionRow {
  id: string
  kb_id: string
  title: string
  messages_json: string
  provider_id: string
  model: string
  created_at: number
  updated_at: number
}

export const kbAskSessionRepo = {
  /** 新增或整行覆盖保存（渲染端持有全量 msgs，upsert 单写路径） */
  upsert(record: KbAskSessionRecord): void {
    dbService
      .getHandle()
      .prepare(
        `INSERT OR REPLACE INTO kb_ask_sessions
         (id, kb_id, title, messages_json, provider_id, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.kbId,
        record.title,
        JSON.stringify(record.messages),
        record.providerId,
        record.model,
        record.createdAt,
        record.updatedAt
      )
  },

  /** 某库的会话列表（元数据，更新时间倒序） */
  listByKb(kbId: string): KbAskSessionMeta[] {
    const rows = dbService
      .getHandle()
      .prepare(
        'SELECT * FROM kb_ask_sessions WHERE kb_id=? ORDER BY updated_at DESC'
      )
      .all(kbId) as SessionRow[]
    return rows.map((r) => ({
      id: r.id,
      kbId: r.kb_id,
      title: r.title,
      messageCount: parseKbAskMessages(r.messages_json).length,
      providerId: r.provider_id,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  },

  /** 读取单个会话全量记录；messages 经容错解析（非法项过滤） */
  get(id: string): KbAskSessionRecord | null {
    const r = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_ask_sessions WHERE id=?')
      .get(id) as SessionRow | undefined
    if (!r) return null
    return {
      id: r.id,
      kbId: r.kb_id,
      title: r.title,
      messages: parseKbAskMessages(r.messages_json),
      providerId: r.provider_id,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM kb_ask_sessions WHERE id=?').run(id)
  },

  /** 仅更新标题与更新时间（重命名，避免全量消息重传） */
  rename(id: string, title: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE kb_ask_sessions SET title=?, updated_at=? WHERE id=?')
      .run(title, Date.now(), id)
  },

  /** 删除某库全部问答会话（KB 删除级联用） */
  deleteByKb(kbId: string): void {
    dbService.getHandle().prepare('DELETE FROM kb_ask_sessions WHERE kb_id=?').run(kbId)
  }
}
