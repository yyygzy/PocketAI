// 消息 IPC：列表 / 删除 / 全局搜索（FTS5 trigram + LIKE 兜底）
import { IPC } from '../../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../../shared/snippet'
import { dbService } from '../../db/database'
import { messageRepo } from '../../db/repositories/message.repo'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { idSchema } from '../../../shared/schemas/providers'

/** 全局搜索 SQL 行（FTS 与 LIKE 两查询同构，FTS 多一个 snippet 列） */
interface MessageSearchRow {
  msg_id: string
  conversation_id: string
  conversation_title?: string | null
  role: string
  content: string
  snippet?: string | null
  created_at: number
}

export function registerMessageHandlers(): void {
  safeHandle(IPC.MESSAGE_LIST, (_e, conversationId: string) =>
    messageRepo.listByConversation(conversationId),
  argsSchema(idSchema))
  safeHandle(IPC.MESSAGE_DELETE, (_e, id: string) => {
    messageRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.MESSAGE_SEARCH, (_e, query: string) => {
    if (!query || query.trim().length < 1) return []
    const q = query.trim()
    const handle = dbService.getHandle()
    const limit = 50

    // FTS5 trigram tokenizer 要求查询 ≥ 3 字符才能有效匹配；
    // 短查询（中文 1-2 字、英文单词前缀）直接走 LIKE，避免无效的 MATCH 尝试
    const shortQuery = [...q].length < 3

    // FTS5 MATCH（trigram，中文 3+ 字，英文连续 3+ 字母）
    if (!shortQuery) {
      try {
        const ftsSql = `
          SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
                 m.created_at, c.title AS conversation_title,
                 snippet(messages_fts, 0, ?, ?, '…', 128) AS snippet
          FROM messages_fts fts
          JOIN messages m ON m.id = fts.message_id
          JOIN conversations c ON c.id = m.conversation_id
          WHERE messages_fts MATCH ?
          ORDER BY m.created_at DESC
          LIMIT ?
        `
        const rows = handle.prepare(ftsSql).all(SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE, q, limit) as MessageSearchRow[]
        if (rows.length > 0) {
          return rows.map(r => ({
            messageId: r.msg_id,
            conversationId: r.conversation_id,
            conversationTitle: r.conversation_title ?? '',
            role: r.role,
            content: r.content,
            snippet: r.snippet ?? '',
            createdAt: r.created_at
          }))
        }
      } catch { /* FTS5 不可用 → 走 LIKE */ }
    }

    // Fallback: LIKE 兜底（短查询、特殊字符、未建 FTS5 索引等）
    const likeSql = `
      SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
             m.created_at, c.title AS conversation_title
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`
    const rows = handle.prepare(likeSql).all(like, limit) as MessageSearchRow[]
    const lq = q.toLowerCase()
    return rows.map(r => {
      const content = String(r.content ?? '')
      const idx = content.toLowerCase().indexOf(lq)
      let snippet: string
      if (idx >= 0) {
        const start = Math.max(0, idx - 30)
        const end = Math.min(content.length, idx + q.length + 60)
        const before = start > 0 ? '…' : ''
        const after = end < content.length ? '…' : ''
        snippet = before + content.slice(start, idx) + SNIPPET_MARK_OPEN + content.slice(idx, idx + q.length) + SNIPPET_MARK_CLOSE + content.slice(idx + q.length, end) + after
      } else {
        snippet = content.slice(0, 128)
      }
      return {
        messageId: r.msg_id,
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title ?? '',
        role: r.role,
        content: r.content,
        snippet,
        createdAt: r.created_at
      }
    })
  }, argsSchema(z.string()))
}
