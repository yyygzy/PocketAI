// 用量聚合服务：从 messages.usage（JSON 列）汇总 token 用量
// 数据来源：chat 与 agent 链路在生成完成时把 provider 返回的 usage 落库（v25 migration）
// 聚合在 JS 侧完成（行级数据量可控，且坏 JSON 容错/时区日切比 SQL JSON 函数更直观可控）
import { dbService } from '../db/database'
import type { ModelPrice, UsageStats, UsageSummary } from '../../shared/types'
import { computeUsageCost, priceKey, roundCost } from './pricing'

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

class UsageService {
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
