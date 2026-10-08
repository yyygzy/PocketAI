// 消息 IPC：列表 / 删除 / 全局搜索（FTS5 trigram + LIKE 兜底）
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../../shared/snippet'
import { dbService } from '../../db/database'
import { messageRepo } from '../../db/repositories/message.repo'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { appConfigRepo } from '../../db/repositories/app-config.repo'
import { usageService } from '../../usage/usage-service'
import { getUsagePricing, setUsagePricing } from '../../usage/pricing-config'
import { parsePricing } from '../../../shared/usage-pricing'
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
  /** LIKE 兜底路径带出（附件名命中时生成 📎 snippet 用）；FTS 路径不查询该列 */
  attachments?: string | null
  snippet?: string | null
  created_at: number
}

/** 用量 CSV 内容上限（约 2 万行明细，远超正常月度导出量，仅做防灌爆） */
const USAGE_CSV_MAX_CHARS = 5_000_000

/**
 * 附件文件名匹配 SQL 片段：json_each 展开 attachments JSON 数组，instr 子串匹配（避免 LIKE 通配符转义问题；
 * lower() 双侧保持与 LIKE/FTS 一致的 ASCII 大小写不敏感语义）。锚定 $.name 字段，不会误命中图片 base64 data。
 */
const ATT_NAME_MATCH = `EXISTS (SELECT 1 FROM json_each(m.attachments) je WHERE instr(lower(json_extract(je.value, '$.name')), lower(?)) > 0)`
/** 附件命中时的 snippet：📎 前缀 + 文件名（与 agent-shared 附件清单同款标记） */
const ATT_NAME_SNIPPET = `(SELECT '📎 ' || json_extract(je.value, '$.name') FROM json_each(m.attachments) je WHERE instr(lower(json_extract(je.value, '$.name')), lower(?)) > 0 LIMIT 1)`

/** 导出文件名时间戳 YYYYMMDD-HHmm（与管家报告导出同手法） */
function usageFileTimestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export function registerMessageHandlers(): void {
  safeHandle(IPC.MESSAGE_LIST, (_e, conversationId: string) =>
    messageRepo.listByConversation(conversationId),
  argsSchema(idSchema))
  safeHandle(IPC.MESSAGE_DELETE, (_e, id: string) => {
    messageRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))

  // 批量删除：单 IPC 删除多条消息（上限 500）
  safeHandle(IPC.MESSAGE_DELETE_BATCH, (_e, ids: string[]) => {
    const deleted = messageRepo.deleteBatch(ids)
    return { ok: true, deleted }
  }, argsSchema(z.array(idSchema).min(1).max(500)))

  // 截断重跑：删除目标消息及同会话其后全部消息（Agent 线性历史「重新运行」）
  safeHandle(IPC.MESSAGE_TRUNCATE_FROM, (_e, id: string) => {
    const deleted = messageRepo.truncateFrom(id)
    return { ok: true, deleted }
  }, argsSchema(idSchema))

  // 收藏星标：标记/取消重要消息
  safeHandle(IPC.MESSAGE_SET_STARRED, (_e, id: string, starred: boolean) => {
    messageRepo.setStarred(id, starred)
    return { ok: true }
  }, argsSchema(idSchema, z.boolean()))

  // 收藏列表：跨会话统一查看（时间倒序，上限 500 由渲染端控制更小的默认值）
  safeHandle(IPC.MESSAGE_LIST_STARRED, (_e, limit?: number) =>
    messageRepo.listStarred(limit),
    argsSchema(z.number().int().min(1).max(500).optional()))

  // 消息置顶：会话内钉住关键消息（ChatView 顶部横幅从 messages 派生，无需单独查询通道）
  safeHandle(IPC.MESSAGE_SET_PINNED, (_e, id: string, pinned: boolean) => {
    messageRepo.setPinned(id, pinned)
    return { ok: true }
  }, argsSchema(idSchema, z.boolean()))

  // 跨会话转发：往目标会话插入一条不触发 AI 的消息；targetConvId=null 时先按源会话助手维度新建会话
  safeHandle(IPC.MESSAGE_FORWARD, (_e, input: {
    targetConvId: string | null
    sourceConvId: string | null
    role: 'user' | 'assistant'
    content: string
    model: string | null
  }) => {
    let convId = input.targetConvId
    if (!convId) {
      const src = input.sourceConvId ? conversationRepo.get(input.sourceConvId) : null
      convId = conversationRepo.create({ assistantId: src?.assistantId ?? null }).id
    }
    const msg = messageRepo.insert({
      conversationId: convId,
      role: input.role,
      content: input.content,
      model: input.model,
      status: 'done'
    })
    conversationRepo.touch(convId)
    return { ok: true, convId, messageId: msg.id }
  }, argsSchema(z.object({
    targetConvId: idSchema.nullable(),
    sourceConvId: idSchema.nullable(),
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(200_000),
    model: z.string().max(200).nullable()
  })))

  // 用量聚合汇总（token 用量按日/provider/模型，最近 N 天；费用按本地单价估算）
  safeHandle(IPC.USAGE_GET, (_e, days?: number) =>
    usageService.getSummary(days, getUsagePricing().prices),
    argsSchema(z.number().int().min(1).max(365).optional()))

  // 会话维度用量排行（UsagePanel 会话排行区块；随天数范围联动）
  safeHandle(IPC.USAGE_CONVERSATIONS, (_e, days?: number, limit?: number) =>
    usageService.listConversationUsage(days, limit, getUsagePricing().prices),
    argsSchema(z.number().int().min(1).max(365).optional(), z.number().int().min(1).max(100).optional()))

  // 助手维度用量排行（UsagePanel 助手排行区块；随天数范围联动）
  safeHandle(IPC.USAGE_ASSISTANTS, (_e, days?: number, limit?: number) =>
    usageService.listAssistantUsage(days, limit, getUsagePricing().prices),
    argsSchema(z.number().int().min(1).max(365).optional(), z.number().int().min(1).max(100).optional()))

  // 用量单价配置：读取 / 保存（zod 过边界 + parsePricing 规范化）/ 历史模型清单
  safeHandle(IPC.USAGE_PRICING_GET, () => getUsagePricing())
  safeHandle(IPC.USAGE_PRICING_SET, (_e, payload: unknown) => {
    const parsed = usagePricingSchema.parse(payload)
    const normalized = parsePricing(parsed)
    setUsagePricing(normalized)
    return normalized
  }, argsSchema(usagePricingSchema))
  safeHandle(IPC.USAGE_MODELS, () => usageService.listDistinctModels())

  // 用量预算：读取状态（含今日/本月已花估算）；保存后返回最新状态
  safeHandle(IPC.USAGE_BUDGET_GET, () =>
    usageService.getBudgetStatus(getUsagePricing().prices))
  safeHandle(IPC.USAGE_BUDGET_SET, (_e, daily: number | null, monthly: number | null, hardBlock?: boolean, warn?: boolean) => {
    appConfigRepo.setUsageBudgetDaily(daily)
    appConfigRepo.setUsageBudgetMonthly(monthly)
    if (typeof hardBlock === 'boolean') appConfigRepo.setUsageBudgetHardBlock(hardBlock)
    if (typeof warn === 'boolean') appConfigRepo.setUsageBudgetWarn(warn)
    return usageService.getBudgetStatus(getUsagePricing().prices)
  }, argsSchema(z.number().min(0).nullable(), z.number().min(0).nullable(), z.boolean().optional(), z.boolean().optional()))

  // 行级用量明细（CSV 导出，最近 N 天；超出 limit 置 truncated 让渲染端提示；
  // conversationId 非空只查该会话；assistantId 非 undefined 按助手过滤（null=自由会话））
  safeHandle(IPC.USAGE_DETAIL_GET, (_e, days?: number, limit?: number, conversationId?: string, assistantId?: string | null) =>
    usageService.listUsageDetail(days, limit, getUsagePricing().prices, conversationId, assistantId),
    argsSchema(
      z.number().int().min(1).max(365).optional(),
      z.number().int().min(1).max(20000).optional(),
      z.string().max(64).optional(),
      z.string().max(64).nullable().optional()
    ))

  // 用量明细 CSV 落盘：渲染端拼装（含 UTF-8 BOM）→ 主进程弹保存框写文件
  safeHandle(
    IPC.USAGE_EXPORT_CSV,
    async (e, args: { days: number; content: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
      if (!win) return { ok: false as const, error: '窗口不可用' }
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `pocketai-usage-${args.days}d-${usageFileTimestamp()}.csv`,
        filters: [
          { name: 'CSV 文件', extensions: ['csv'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: true as const, canceled: true as const }
      fs.writeFileSync(filePath, args.content, 'utf8')
      return { ok: true as const, path: filePath }
    },
    argsSchema(z.object({ days: z.number().int().min(1).max(365), content: z.string().min(1).max(USAGE_CSV_MAX_CHARS) }))
  )
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
    // UNION 附件名匹配分支：content 未命中但附件文件名命中的消息也可搜到（NOT IN 去重已命中行）
    if (!shortQuery) {
      try {
        const ftsSql = `
          SELECT * FROM (
            SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
                   m.created_at, c.title AS conversation_title,
                   snippet(messages_fts, 0, ?, ?, '…', 128) AS snippet
            FROM messages_fts fts
            JOIN messages m ON m.id = fts.message_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE messages_fts MATCH ?${asstFilter}${dateFilter}${dateToFilter}
            UNION
            SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
                   m.created_at, c.title AS conversation_title,
                   ${ATT_NAME_SNIPPET} AS snippet
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.attachments IS NOT NULL AND ${ATT_NAME_MATCH}
              AND m.id NOT IN (SELECT message_id FROM messages_fts WHERE messages_fts MATCH ?)
              ${asstFilter}${dateFilter}${dateToFilter}
          )
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `
        const ftsParams: (string | number)[] = [SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE, q]
        if (assistantId) ftsParams.push(assistantId)
        if (dateRange?.from != null) ftsParams.push(dateRange.from)
        if (dateRange?.to != null) ftsParams.push(dateRange.to)
        ftsParams.push(q, q, q) // 附件分支：snippet 取名 / EXISTS 匹配 / NOT IN 去重
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
    // 附件名也参与匹配：content LIKE 或 attachments 中任一文件名命中
    const likeSql = `
      SELECT m.id AS msg_id, m.conversation_id, m.role, m.content, m.attachments,
             m.created_at, c.title AS conversation_title
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE (m.content LIKE ? OR (m.attachments IS NOT NULL AND ${ATT_NAME_MATCH}))${asstFilter}${dateFilter}${dateToFilter}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`
    const likeParams: (string | number)[] = [like, q]
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
      } else if (r.attachments) {
        // 内容未命中 → 按附件名生成 snippet（📎 标记 + 文件名）
        try {
          const atts = JSON.parse(r.attachments) as { name?: string }[]
          const hit = atts.find((a) => typeof a.name === 'string' && a.name.toLowerCase().includes(lq))
          snippet = hit ? '📎 ' + hit.name : content.slice(0, 128)
        } catch {
          snippet = content.slice(0, 128)
        }
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
