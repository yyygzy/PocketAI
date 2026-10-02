// KB 问答会话数据访问
//
// kb_ask_sessions 表结构（v33 迁移）：
//   id TEXT PK, kb_id TEXT, title TEXT, messages_json TEXT,
//   provider_id TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
// 一个问答会话一行，消息体（含引用来源）JSON 单列存储；
// 列表按库过滤、更新时间倒序，返回瘦身元数据不含消息正文。
import { dbService } from '../database'
import { parseKbAskMessages } from '../../../shared/kb-ask-session'
import type {
  KbAskRetention,
  KbAskRoamItem,
  KbAskSessionMeta,
  KbAskSessionRecord
} from '../../../shared/types'

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

/** 跨库漫游行：会话元数据 + 所属库名（LEFT JOIN，库被删时 kb_name 为 null） */
type RoamRow = SessionRow & { kb_name: string | null }

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
  },

  /**
   * 按保留策略清理某库问答会话，返回删除条数。
   * keepDays>0 删除 updated_at 早于阈值的；keepCount>0 仅保留最近 N 条。
   * 双 0 不删（调用方应已判空，此处防御兜底）。
   */
  prune(kbId: string, policy: KbAskRetention): number {
    let deleted = 0
    if (policy.keepDays > 0) {
      const cutoff = Date.now() - policy.keepDays * 86_400_000
      deleted += dbService
        .getHandle()
        .prepare('DELETE FROM kb_ask_sessions WHERE kb_id=? AND updated_at < ?')
        .run(kbId, cutoff).changes
    }
    if (policy.keepCount > 0) {
      deleted += dbService
        .getHandle()
        .prepare(
          `DELETE FROM kb_ask_sessions
           WHERE kb_id=? AND id NOT IN (
             SELECT id FROM kb_ask_sessions WHERE kb_id=? ORDER BY updated_at DESC LIMIT ?
           )`
        )
        .run(kbId, kbId, policy.keepCount).changes
    }
    return deleted
  },

  /** 搜索某库的问答会话：标题或消息体包含关键词（空串返回全部列表） */
  searchByKb(kbId: string, keyword: string): KbAskSessionMeta[] {
    const kw = keyword.trim()
    if (!kw) return this.listByKb(kbId)
    const like = `%${kw}%`
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT * FROM kb_ask_sessions
         WHERE kb_id=? AND (title LIKE ? OR messages_json LIKE ?)
         ORDER BY updated_at DESC`
      )
      .all(kbId, like, like) as SessionRow[]
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

  /**
   * 跨库漫游：全部库最近会话（更新时间倒序，限量）。
   * LEFT JOIN knowledge_bases 带库名；库被删已级联清理会话，kb_name 理论非空，
   * null 时回落空串由 UI 层兜底显示。
   */
  listAll(limit: number): KbAskRoamItem[] {
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT s.*, k.name AS kb_name
         FROM kb_ask_sessions s
         LEFT JOIN knowledge_bases k ON k.id = s.kb_id
         ORDER BY s.updated_at DESC
         LIMIT ?`
      )
      .all(limit) as RoamRow[]
    return rows.map((r) => ({
      id: r.id,
      kbId: r.kb_id,
      title: r.title,
      messageCount: parseKbAskMessages(r.messages_json).length,
      providerId: r.provider_id,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      kbName: r.kb_name ?? ''
    }))
  },

  /** 跨库搜索：标题或消息体包含关键词（空串回退全量漫游列表） */
  searchAll(keyword: string, limit: number): KbAskRoamItem[] {
    const kw = keyword.trim()
    if (!kw) return this.listAll(limit)
    const like = `%${kw}%`
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT s.*, k.name AS kb_name
         FROM kb_ask_sessions s
         LEFT JOIN knowledge_bases k ON k.id = s.kb_id
         WHERE s.title LIKE ? OR s.messages_json LIKE ?
         ORDER BY s.updated_at DESC
         LIMIT ?`
      )
      .all(like, like, limit) as RoamRow[]
    return rows.map((r) => ({
      id: r.id,
      kbId: r.kb_id,
      title: r.title,
      messageCount: parseKbAskMessages(r.messages_json).length,
      providerId: r.provider_id,
      model: r.model,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      kbName: r.kb_name ?? ''
    }))
  }
}
