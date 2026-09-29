// 用量聚合服务：从 messages.usage（JSON 列）汇总 token 用量
// 数据来源：chat 与 agent 链路在生成完成时把 provider 返回的 usage 落库（v25 migration）
// 聚合在 JS 侧完成（行级数据量可控，且坏 JSON 容错/时区日切比 SQL JSON 函数更直观可控）
import { dbService } from '../db/database'
import type { UsageStats, UsageSummary } from '../../shared/types'

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
 */
export function aggregateUsage(rows: UsageRow[], days: number): UsageSummary {
  const totals = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }
  const dailyMap = new Map<string, number>()
  const providerMap = new Map<string, { requests: number; totalTokens: number }>()
  const modelMap = new Map<string, { provider: string; model: string; requests: number; totalTokens: number }>()

  // 补零填充：范围内每一天都有柱
  const today = new Date()
  const dayMs = 24 * 3600 * 1000
  for (let i = days - 1; i >= 0; i--) {
    dailyMap.set(localDateKey(today.getTime() - i * dayMs), 0)
  }

  for (const row of rows) {
    const u = parseUsageJson(row.usage)
    if (!u) continue
    // 范围外的行整体跳过，保证 totals 与 daily/byProvider 口径一致
    const dateKey = localDateKey(row.created_at)
    if (!dailyMap.has(dateKey)) continue

    totals.requests++
    totals.promptTokens += u.promptTokens
    totals.completionTokens += u.completionTokens
    totals.totalTokens += u.totalTokens
    totals.cachedTokens += u.cachedTokens ?? 0

    dailyMap.set(dateKey, (dailyMap.get(dateKey) ?? 0) + u.totalTokens)

    const provider = row.provider || '(未知)'
    const p = providerMap.get(provider) ?? { requests: 0, totalTokens: 0 }
    p.requests++
    p.totalTokens += u.totalTokens
    providerMap.set(provider, p)

    const model = row.model || '(未知)'
    const mKey = `${provider}::${model}`
    const m = modelMap.get(mKey) ?? { provider, model, requests: 0, totalTokens: 0 }
    m.requests++
    m.totalTokens += u.totalTokens
    modelMap.set(mKey, m)
  }

  const byProvider = Array.from(providerMap.entries())
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const byModel = Array.from(modelMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 10)

  return {
    days,
    totals,
    daily: Array.from(dailyMap.entries()).map(([date, totalTokens]) => ({ date, totalTokens })),
    byProvider,
    byModel
  }
}

class UsageService {
  /** 查询最近 days 天的用量汇总（仅统计 status='done' 的 assistant 消息） */
  getSummary(days = 30): UsageSummary {
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
    return aggregateUsage(rows, safeDays)
  }
}

export const usageService = new UsageService()
