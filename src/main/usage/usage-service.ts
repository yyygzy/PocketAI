// 用量聚合服务：从 messages.usage（JSON 列）汇总 token 用量
// 数据来源：chat 与 agent 链路在生成完成时把 provider 返回的 usage 落库（v25 migration）
// 聚合在 JS 侧完成（行级数据量可控，且坏 JSON 容错/时区日切比 SQL JSON 函数更直观可控）
import { dbService } from '../db/database'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { ModelPrice, UsageAssistantItem, UsageBudgetStatus, UsageConversationItem, UsageDetailItem, UsageStats, UsageSummary, BudgetWarnEvent } from '../../shared/types'
import { computeUsageCost, priceKey, roundCost } from '../../shared/usage-pricing'

/** 聚合输入行（SQL 只拉必要列） */
export interface UsageRow {
  provider: string | null
  model: string | null
  usage: string | null
  created_at: number
}

/** 本地日期键（YYYY-MM-DD，按本地时区切日） */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地月份键（YYYY-MM，预算月周期用） */
export function localMonthKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 预算软预警阈值：花费达到上限 80% 触发 */
export const BUDGET_WARN_RATIO = 0.8

/**
 * 纯判定：本次检查新跨越 80% 阈值的预算周期（不含任何 IO，供单测）。
 * 规则：总开关关 → 空；daily/monthly 独立判定；上限 null/≤0 跳过；
 * 已弹过（warnedXxx）跳过；cost >= limit*0.8（边界含等号）才入选；顺序 daily 先。
 */
export function pickBudgetWarnings(
  status: UsageBudgetStatus,
  opts: { enabled: boolean; warnedDaily: boolean; warnedMonthly: boolean }
): BudgetWarnEvent[] {
  if (!opts.enabled) return []
  const events: BudgetWarnEvent[] = []
  if (
    status.daily !== null &&
    status.daily > 0 &&
    !opts.warnedDaily &&
    status.todayCost >= status.daily * BUDGET_WARN_RATIO
  ) {
    events.push({
      scope: 'daily',
      cost: status.todayCost,
      limit: status.daily,
      ratio: Math.round((status.todayCost / status.daily) * 10000) / 10000
    })
  }
  if (
    status.monthly !== null &&
    status.monthly > 0 &&
    !opts.warnedMonthly &&
    status.monthCost >= status.monthly * BUDGET_WARN_RATIO
  ) {
    events.push({
      scope: 'monthly',
      cost: status.monthCost,
      limit: status.monthly,
      ratio: Math.round((status.monthCost / status.monthly) * 10000) / 10000
    })
  }
  return events
}

/** 解析 usage JSON，坏数据/形状不符返回 null（不阻断聚合） */
export function parseUsageJson(raw: string | null): UsageStats | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<UsageStats> | null
    if (!v || typeof v !== 'object') return null
    const prompt = Number(v.promptTokens)
    const completion = Number(v.completionTokens)
    const total = Number(v.totalTokens)
    if (![prompt, completion, total].every((n) => Number.isFinite(n) && n >= 0)) return null
    const cached = Number(v.cachedTokens)
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      ...(Number.isFinite(cached) && cached > 0 ? { cachedTokens: cached } : {})
    }
  } catch {
    return null
  }
}

/**
 * 聚合用量行 → UsageSummary。
 * daily 按本地时区切日并补零填充范围内每一天；byModel 取 Top10。
 * prices 为 `${provider}::${model}` 单价表；未配置的模型费用计 0（token 统计不受影响）。
 */
export function aggregateUsage(
  rows: UsageRow[],
  days: number,
  prices: Record<string, ModelPrice> = {}
): UsageSummary {
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0 }
  const dailyMap = new Map<string, number>()
  // dailyCost 与 dailyMap 平行维护（dailyMap 承担补零键全集）
  const dailyCostMap = new Map<string, number>()
  const providerMap = new Map<string, { requests: number; totalTokens: number; cost: number }>()
  const modelMap = new Map<string, { provider: string; model: string; requests: number; totalTokens: number; cost: number }>()

  // 补零填充：范围内每一天都有柱
  const today = new Date()
  const dayMs = 24 * 3600 * 1000
  for (let i = days - 1; i >= 0; i--) {
    const key = localDateKey(today.getTime() - i * dayMs)
    dailyMap.set(key, 0)
    dailyCostMap.set(key, 0)
  }

  for (const row of rows) {
    const u = parseUsageJson(row.usage)
    if (!u) continue
    // 范围外的行整体跳过，保证 totals 与 daily/byProvider 口径一致
    const dateKey = localDateKey(row.created_at)
    if (!dailyMap.has(dateKey)) continue

    const provider = row.provider || '(未知)'
    const model = row.model || '(未知)'
    const cost = prices[priceKey(provider, model)]
      ? computeUsageCost(u, prices[priceKey(provider, model)]!)
      : 0

    totals.requests++
    totals.promptTokens += u.promptTokens
    totals.completionTokens += u.completionTokens
    totals.totalTokens += u.totalTokens
    totals.cachedTokens += u.cachedTokens ?? 0
    totals.cost += cost

    dailyMap.set(dateKey, (dailyMap.get(dateKey) ?? 0) + u.totalTokens)
    dailyCostMap.set(dateKey, (dailyCostMap.get(dateKey) ?? 0) + cost)

    const p = providerMap.get(provider) ?? { requests: 0, totalTokens: 0, cost: 0 }
    p.requests++
    p.totalTokens += u.totalTokens
    p.cost += cost
    providerMap.set(provider, p)

    const mKey = `${provider}::${model}`
    const m = modelMap.get(mKey) ?? { provider, model, requests: 0, totalTokens: 0, cost: 0 }
    m.requests++
    m.totalTokens += u.totalTokens
    m.cost += cost
    modelMap.set(mKey, m)
  }

  const byProvider = Array.from(providerMap.entries())
    .map(([provider, v]) => ({ provider, ...v, cost: roundCost(v.cost) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const byModel = Array.from(modelMap.values())
    .map((m) => ({ ...m, cost: roundCost(m.cost) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10)

  return {
    days,
    totals: { ...totals, cost: roundCost(totals.cost) },
    daily: Array.from(dailyMap.entries()).map(([date, totalTokens]) => ({
      date,
      totalTokens,
      cost: roundCost(dailyCostMap.get(date) ?? 0)
    })),
    byProvider,
    byModel
  }
}

/** 会话维度聚合输入行（LEFT JOIN conversations 带出标题） */
export interface UsageConversationRow extends UsageRow {
  conversation_id: string
  title: string | null
}

/**
 * 聚合会话维度用量行 → UsageConversationItem[]（按 totalTokens 倒序）。
 * 与 aggregateUsage 同口径：坏 JSON 跳过、未配单价费用计 0、roundCost 消浮点尾巴。
 * 会话标题取 JOIN 值，空/NULL 兜底「(未知会话)」；时间过滤由 SQL created_at >= since 承担。
 */
export function aggregateConversationUsage(
  rows: UsageConversationRow[],
  prices: Record<string, ModelPrice> = {}
): UsageConversationItem[] {
  const convMap = new Map<
    string,
    { title: string; requests: number; totalTokens: number; cost: number; lastUsedAt: number }
  >()
  for (const row of rows) {
    const u = parseUsageJson(row.usage)
    if (!u) continue
    const id = row.conversation_id || '(未知会话)'
    const title = row.title?.trim() || '(未知会话)'
    const cost = prices[priceKey(row.provider || '(未知)', row.model || '(未知)')]
      ? computeUsageCost(u, prices[priceKey(row.provider || '(未知)', row.model || '(未知)')]!)
      : 0
    const c = convMap.get(id) ?? { title, requests: 0, totalTokens: 0, cost: 0, lastUsedAt: 0 }
    // 标题以首条非空为准（同会话行 JOIN 值一致，防御性取非空）
    if (!c.title || c.title === '(未知会话)') c.title = title
    c.requests++
    c.totalTokens += u.totalTokens
    c.cost += cost
    c.lastUsedAt = Math.max(c.lastUsedAt, row.created_at)
    convMap.set(id, c)
  }
  return Array.from(convMap.entries())
    .map(([conversationId, v]) => ({ conversationId, ...v, cost: roundCost(v.cost) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

/** 助手维度聚合输入行（LEFT JOIN assistants 带出名称，conversations 带出归属） */
export interface UsageAssistantRow extends UsageRow {
  assistant_id: string | null
  name: string | null
}

/**
 * 聚合助手维度用量行 → UsageAssistantItem[]（按 totalTokens 倒序）。
 * 与 aggregateConversationUsage 同口径：坏 JSON 跳过、未配单价费用计 0、roundCost 消浮点尾巴。
 * 助手名称取 JOIN 值，空/NULL/已删除兜底「(未知助手)」；时间过滤由 SQL created_at >= since 承担。
 */
export function aggregateAssistantUsage(
  rows: UsageAssistantRow[],
  prices: Record<string, ModelPrice> = {}
): UsageAssistantItem[] {
  const asstMap = new Map<
    string,
    { name: string; requests: number; totalTokens: number; cost: number; lastUsedAt: number }
  >()
  for (const row of rows) {
    const u = parseUsageJson(row.usage)
    if (!u) continue
    const id = row.assistant_id || '(未知助手)'
    const name = row.name?.trim() || '(未知助手)'
    const cost = prices[priceKey(row.provider || '(未知)', row.model || '(未知)')]
      ? computeUsageCost(u, prices[priceKey(row.provider || '(未知)', row.model || '(未知)')]!)
      : 0
    const a = asstMap.get(id) ?? { name, requests: 0, totalTokens: 0, cost: 0, lastUsedAt: 0 }
    // 名称以首条非空为准（同助手行 JOIN 值一致，防御性取非空）
    if (!a.name || a.name === '(未知助手)') a.name = name
    a.requests++
    a.totalTokens += u.totalTokens
    a.cost += cost
    a.lastUsedAt = Math.max(a.lastUsedAt, row.created_at)
    asstMap.set(id, a)
  }
  return Array.from(asstMap.entries())
    .map(([assistantId, v]) => ({ assistantId, ...v, cost: roundCost(v.cost) }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

/** 行级明细聚合输入行（JOIN conversations + assistants 带出标题与助手名） */
export interface UsageDetailRow extends UsageRow {
  message_id: string
  conversation_id: string
  conversation_title: string | null
  assistant_id: string | null
  assistant_name: string | null
}

/**
 * 聚合行级用量明细 → UsageDetailItem[]（CSV 导出用，每轮生成一行）。
 * 与既有聚合同口径：坏 JSON 跳过、未配单价费用计 0、roundCost 消浮点尾巴；保持入参顺序（SQL 已按时间倒序）。
 */
export function aggregateUsageDetail(
  rows: UsageDetailRow[],
  prices: Record<string, ModelPrice> = {}
): UsageDetailItem[] {
  const items: UsageDetailItem[] = []
  for (const row of rows) {
    const u = parseUsageJson(row.usage)
    if (!u) continue
    const provider = row.provider || '(未知)'
    const model = row.model || '(未知)'
    const cost = prices[priceKey(provider, model)]
      ? computeUsageCost(u, prices[priceKey(provider, model)]!)
      : 0
    items.push({
      createdAt: row.created_at,
      messageId: row.message_id,
      conversationId: row.conversation_id || '(未知会话)',
      conversationTitle: row.conversation_title?.trim() || '(未知会话)',
      assistantId: row.assistant_id,
      assistantName: row.assistant_name?.trim() || null,
      provider,
      model,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      cachedTokens: u.cachedTokens ?? 0,
      totalTokens: u.totalTokens,
      cost: roundCost(cost)
    })
  }
  return items
}

/**
 * 明细查询维度过滤拼装（纯函数，便于单测）。
 * conversationId 非空 → 按会话过滤；assistantId：undefined=不过滤、null=自由会话（IS NULL）、字符串=按助手过滤。
 * 返回片段以空格开头，可直接拼进 WHERE 尾部；vals 顺序与片段占位符一致。
 */
export function buildUsageDetailScope(
  conversationId?: string,
  assistantId?: string | null
): { sql: string; vals: unknown[] } {
  const conds: string[] = []
  const vals: unknown[] = []
  if (conversationId) {
    conds.push('AND m.conversation_id = ?')
    vals.push(conversationId)
  }
  if (assistantId === null) {
    conds.push('AND c.assistant_id IS NULL')
  } else if (assistantId) {
    conds.push('AND c.assistant_id = ?')
    vals.push(assistantId)
  }
  return { sql: conds.length ? ' ' + conds.join(' ') : '', vals }
}

class UsageService {
  /** 汇总一批 usage 行的估算费用（预算/面板共用口径：仅 done + usage 非空；未配置单价的模型计 0） */
  private sumCostSince(sinceTs: number, prices: Record<string, ModelPrice>): number {
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT provider, model, usage, created_at FROM messages
         WHERE role='assistant' AND status='done' AND usage IS NOT NULL AND created_at >= ?`
      )
      .all(sinceTs) as UsageRow[]
    let cost = 0
    for (const row of rows) {
      const u = parseUsageJson(row.usage)
      if (!u) continue
      const p = prices[priceKey(row.provider || '(未知)', row.model || '(未知)')]
      if (p) cost += computeUsageCost(u, p)
    }
    return roundCost(cost)
  }

  /** 预算状态：今日（本地 0 点起）/ 本月（1 号起）估算费用 + 已配置预算（null=不限制） */
  getBudgetStatus(prices: Record<string, ModelPrice> = {}): UsageBudgetStatus {
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    return {
      daily: appConfigRepo.getUsageBudgetDaily(),
      monthly: appConfigRepo.getUsageBudgetMonthly(),
      todayCost: this.sumCostSince(dayStart, prices),
      monthCost: this.sumCostSince(monthStart, prices),
      hardBlock: appConfigRepo.isUsageBudgetHardBlockEnabled(),
      warn: appConfigRepo.isUsageBudgetWarnEnabled()
    }
  }

  /**
   * 消费一次软预警检查（每次 usage 落库后调用；全程同步，并发调用靠 KV 标记天然去重）：
   * 新跨越 80% 的周期写「本周期已提醒」标记后返回事件；调用方负责广播。
   * 周期键随日期/月份滚动，旧标记不清理（年累积量可忽略）。
   */
  consumeBudgetWarnings(prices: Record<string, ModelPrice> = {}): BudgetWarnEvent[] {
    const now = Date.now()
    const status = this.getBudgetStatus(prices)
    const dayKey = localDateKey(now)
    const monthKey = localMonthKey(now)
    const events = pickBudgetWarnings(status, {
      enabled: status.warn,
      warnedDaily: appConfigRepo.isBudgetWarned('daily', dayKey),
      warnedMonthly: appConfigRepo.isBudgetWarned('monthly', monthKey)
    })
    for (const ev of events) {
      appConfigRepo.markBudgetWarned(ev.scope, ev.scope === 'daily' ? dayKey : monthKey)
    }
    return events
  }

  /**
   * 检查预算是否超限（供硬阻断判断）。
   * daily/monthly 任一已花 >= 上限即超限；null 上限=不限制，跳过。
   * 返回超限详情或 null（未超限）。
   */
  checkBudgetExceeded(prices: Record<string, ModelPrice> = {}): {
    scope: 'daily' | 'monthly'
    cost: number
    limit: number
  } | null {
    const status = this.getBudgetStatus(prices)
    if (status.daily !== null && status.todayCost >= status.daily) {
      return { scope: 'daily', cost: status.todayCost, limit: status.daily }
    }
    if (status.monthly !== null && status.monthCost >= status.monthly) {
      return { scope: 'monthly', cost: status.monthCost, limit: status.monthly }
    }
    return null
  }

  /** 查询最近 days 天的用量汇总（仅统计 status='done' 的 assistant 消息） */
  getSummary(days = 30, prices: Record<string, ModelPrice> = {}): UsageSummary {
    const safeDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30
    const since = Date.now() - safeDays * 24 * 3600 * 1000
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT provider, model, usage, created_at FROM messages
         WHERE role='assistant' AND status='done' AND usage IS NOT NULL AND created_at >= ?
         ORDER BY created_at ASC`
      )
      .all(since) as UsageRow[]
    return aggregateUsage(rows, safeDays, prices)
  }

  /**
   * 会话维度用量排行（UsagePanel 会话排行区块）。
   * LEFT JOIN conversations 带出标题（会话已删除时 title 为 NULL，聚合侧兜底）；
   * limit 截断在聚合后按 totalTokens 倒序取前 N。
   */
  listConversationUsage(
    days = 30,
    limit = 20,
    prices: Record<string, ModelPrice> = {}
  ): UsageConversationItem[] {
    const safeDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20
    const since = Date.now() - safeDays * 24 * 3600 * 1000
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT m.conversation_id, c.title, m.provider, m.model, m.usage, m.created_at
         FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role='assistant' AND m.status='done' AND m.usage IS NOT NULL AND m.created_at >= ?
         ORDER BY m.created_at ASC`
      )
      .all(since) as UsageConversationRow[]
    return aggregateConversationUsage(rows, prices).slice(0, safeLimit)
  }

  /**
   * 助手维度用量排行（UsagePanel 助手排行区块）。
   * conversations LEFT JOIN assistants 带出助手名称（assistant_id 为 NULL/助手已删除时聚合侧兜底）；
   * limit 截断在聚合后按 totalTokens 倒序取前 N。
   */
  listAssistantUsage(
    days = 30,
    limit = 10,
    prices: Record<string, ModelPrice> = {}
  ): UsageAssistantItem[] {
    const safeDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 10
    const since = Date.now() - safeDays * 24 * 3600 * 1000
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT m.provider, m.model, m.usage, m.created_at, c.assistant_id, a.name
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN assistants a ON a.id = c.assistant_id
         WHERE m.role='assistant' AND m.status='done' AND m.usage IS NOT NULL AND m.created_at >= ?
         ORDER BY m.created_at ASC`
      )
      .all(since) as UsageAssistantRow[]
    return aggregateAssistantUsage(rows, prices).slice(0, safeLimit)
  }

  /**
   * 行级用量明细（CSV 导出 / 会话·助手维度明细弹窗）。
   * 内查 limit+1 行判断截断：超出 limit 时 truncated=true 且只返回前 limit 条（时间倒序最近的）。
   * 时间过滤、JOIN 口径与 listAssistantUsage 一致。
   * conversationId 非空时只查该会话；assistantId 非 undefined 时按助手过滤（null=自由会话）。
   */
  listUsageDetail(
    days = 30,
    limit = 10000,
    prices: Record<string, ModelPrice> = {},
    conversationId?: string,
    assistantId?: string | null
  ): { items: UsageDetailItem[]; truncated: boolean } {
    const safeDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 365) : 30
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 20000) : 10000
    const since = Date.now() - safeDays * 24 * 3600 * 1000
    const scope = buildUsageDetailScope(conversationId, assistantId)
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT m.id AS message_id, m.conversation_id, c.title AS conversation_title, c.assistant_id, a.name AS assistant_name,
                m.provider, m.model, m.usage, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN assistants a ON a.id = c.assistant_id
         WHERE m.role='assistant' AND m.status='done' AND m.usage IS NOT NULL AND m.created_at >= ?${scope.sql}
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(since, ...scope.vals, safeLimit + 1) as UsageDetailRow[]
    const truncated = rows.length > safeLimit
    return { items: aggregateUsageDetail(truncated ? rows.slice(0, safeLimit) : rows, prices), truncated }
  }

  /**
   * 历史出现过的 provider/模型清单（单价编辑器用，覆盖全部时间、不受天数范围限制）。
   * 按最近使用倒序，LIMIT 200 防爆；已配置单价但不在清单内的 key 由渲染端合并保留。
   */
  listDistinctModels(limit = 200): { provider: string; model: string; lastUsedAt: number }[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 500)
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT provider, model, MAX(created_at) AS last_used_at
         FROM messages
         WHERE role='assistant' AND status='done' AND provider IS NOT NULL AND model IS NOT NULL
         GROUP BY provider, model
         ORDER BY last_used_at DESC
         LIMIT ?`
      )
      .all(safeLimit) as { provider: string; model: string; last_used_at: number }[]
    return rows.map((r) => ({ provider: r.provider, model: r.model, lastUsedAt: r.last_used_at }))
  }
}

export const usageService = new UsageService()
