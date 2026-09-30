// 用量费用估算纯函数：单价解析/清洗与单次 usage 计费。
// 单价口径：每 100 万 token 的价格（币种由用户在设置中统一选择，仅作展示前缀）。
// 不依赖 electron / DB，便于单测；KV 读写在 pricing-config.ts。
import type { UsagePricing, UsageStats } from '../../shared/types'

/** 价格计量单位：所有单价均为「每 100 万 token」 */
export const PRICE_UNIT = 1_000_000

/** 费用保留小数位（防浮点累加尾巴，同时容纳极小单价） */
export const COST_SCALE = 6

/** 合法币种白名单 */
export const PRICING_CURRENCIES = ['CNY', 'USD'] as const

/** 四舍五入到 COST_SCALE 位小数，消除浮点累加误差 */
export function roundCost(n: number): number {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** COST_SCALE
  return Math.round(n * f) / f
}

/** 单个字段是否为「有限且非负」的有效单价 */
function validPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/**
 * 清洗一条模型单价：input/output 必填且合法；cache 可省略，
 * 给了就必须合法。任何不合法返回 null（整条丢弃，不半用）。
 */
export function sanitizeModelPrice(raw: unknown): UsagePricing['prices'][string] | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!validPrice(v.input) || !validPrice(v.output)) return null
  const price: UsagePricing['prices'][string] = {
    input: v.input,
    output: v.output
  }
  if (v.cache !== undefined && v.cache !== null) {
    if (!validPrice(v.cache)) return null
    price.cache = v.cache
  }
  return price
}

/**
 * 容错解析持久化的计价配置（KV 中的 JSON.parse 结果或任意脏数据）：
 * currency 非白名单回退 CNY；prices 非对象/条目非法整条跳过；key 非字符串跳过。
 */
export function parsePricing(raw: unknown): UsagePricing {
  const fallback: UsagePricing = { currency: 'CNY', prices: {} }
  if (!raw || typeof raw !== 'object') return fallback
  const v = raw as Record<string, unknown>
  const currency = (PRICING_CURRENCIES as readonly string[]).includes(v.currency as string)
    ? (v.currency as UsagePricing['currency'])
    : 'CNY'
  const prices: UsagePricing['prices'] = {}
  if (v.prices && typeof v.prices === 'object') {
    for (const [key, val] of Object.entries(v.prices as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key.includes('::')) continue
      const p = sanitizeModelPrice(val)
      if (p) prices[key] = p
    }
  }
  return { currency, prices }
}

/**
 * 计算单次生成的估算费用：
 *   未命中缓存的输入 × 输入价
 * + 命中缓存的输入   × 缓存价（未配置缓存价时按输入价，不凭空打折）
 * + 输出             × 输出价，再除以 100 万。
 * cachedTokens 是 promptTokens 的子集；异常数据 cached>prompt 时夹到 prompt，保证不为负。
 */
export function computeUsageCost(u: UsageStats, price: UsagePricing['prices'][string]): number {
  const prompt = Math.max(0, u.promptTokens || 0)
  const completion = Math.max(0, u.completionTokens || 0)
  const cached = Math.min(Math.max(0, u.cachedTokens || 0), prompt)
  const cachePrice = price.cache ?? price.input
  const cost =
    ((prompt - cached) * price.input + cached * cachePrice + completion * price.output) / PRICE_UNIT
  return roundCost(cost)
}

/** 价格表 key：providerId::model（与 usage 聚合的 mKey 同构） */
export function priceKey(provider: string, model: string): string {
  return `${provider}::${model}`
}
