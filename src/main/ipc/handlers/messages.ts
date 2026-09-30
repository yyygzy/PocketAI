// 消息 IPC：列表 / 删除 / 全局搜索（FTS5 trigram + LIKE 兜底）
import { IPC } from '../../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../../shared/snippet'
import { dbService } from '../../db/database'
import { messageRepo } from '../../db/repositories/message.repo'
import { usageService } from '../../usage/usage-service'
import { getUsagePricing, setUsagePricing } from '../../usage/pricing-config'
import { parsePricing } from '../../usage/pricing'
import { usagePricingSchema } from '../../../shared/schemas/usage'
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

  // 截断重跑：删除目标消息及同会话其后全部消息（Agent 线性历史「重新运行」）
  safeHandle(IPC.MESSAGE_TRUNCATE_FROM, (_e, id: string) => {
    const deleted = messageRepo.truncateFrom(id)
    return { ok: true, deleted }
  }, argsSchema(idSchema))

  // 用量聚合汇总（token 用量按日/provider/模型，最近 N 天；费用按本地单价估算）
  safeHandle(IPC.USAGE_GET, (_e, days?: number) =>
    usageService.getSummary(days, getUsagePricing().prices),
    argsSchema(z.number().int().min(1).max(365).optional()))

  // 用量单价配置：读取 / 保存（zod 过边界 + parsePricing 规范化）/ 历史模型清单
  safeHandle(IPC.USAGE_PRICING_GET, () => getUsagePricing())
  safeHandle(IPC.USAGE_PRICING_SET, (_e, payload: unknown) => {
    const parsed = usagePricingSchema.parse(payload)
    const normalized = parsePricing(parsed)
    setUsagePricing(normalized)
    return normalized
  }, argsSchema(usagePricingSchema))
  safeHandle(IPC.USAGE_MODELS, () => usageService.listDistinctModels())
  safeHandle(IPC.MESSAGE_SEARCH, (_e, query: string, assistantId?: string | null, dateRange?: { from?: number; to?: number }, offset?: number) => {
    if (!query || query.trim().length < 1) return []
    const q = query.trim()
    const handle = dbService.getHandle()
    const limit = 50
    const off = Math.max(0, offset ?? 0)
    // 可选助手过滤：Agent 侧栏按助手隔离会话；Chat 不传则全局搜索
    const asstFilter = assistantId ? ' AND c.assistant_id = ?' : ''
    // 可选日期范围（from/to 为 Unix 毫秒）
    const dateFilter = dateRange?.from != null ? ' AND m.created_at >= ?' : ''
    const dateToFilter = dateRange?.to != null ? ' AND m.created_at <= ?' : ''

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
          WHERE messages_fts MATCH ?${asstFilter}${dateFilter}${dateToFilter}
          ORDER BY m.created_at DESC
          LIMIT ? OFFSET ?
        `
        const ftsParams: (string | number)[] = [SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE, q]
        if (assistantId) ftsParams.push(assistantId)
        if (dateRange?.from != null) ftsParams.push(dateRange.from)
        if (dateRange?.to != null) ftsParams.push(dateRange.to)
        ftsParams.push(limit, off)
        const rows = handle.prepare(ftsSql).all(...ftsParams) as MessageSearchRow[]
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
      WHERE m.content LIKE ?${asstFilter}${dateFilter}${dateToFilter}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`
    const likeParams: (string | number)[] = [like]
    if (assistantId) likeParams.push(assistantId)
    if (dateRange?.from != null) likeParams.push(dateRange.from)
    if (dateRange?.to != null) likeParams.push(dateRange.to)
    likeParams.push(limit, off)
    const rows = handle.prepare(likeSql).all(...likeParams) as MessageSearchRow[]
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
  }, argsSchema(z.string(), z.string().nullish(), z.object({ from: z.number().optional(), to: z.number().optional() }).optional(), z.number().int().min(0).optional()))
}
