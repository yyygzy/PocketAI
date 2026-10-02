// pricing 用量费用估算纯函数测试
//
// 覆盖 src/shared/usage-pricing.ts（零依赖，主进程与渲染端共用）：
// - computeUsageCost：输入/缓存/输出分段计价、缓存价留空回退输入价、异常缓存夹断、全 0 价
// - parsePricing：币种白名单回退、prices 脏数据整条丢弃、key 合法性
// - sanitizeModelPrice：input/output 必填、cache 可空、cache=0 保留
// - priceKey/roundCost 基础
import { describe, it, expect } from 'vitest'
import {
  PRICE_UNIT,
  roundCost,
  sanitizeModelPrice,
  parsePricing,
  computeUsageCost,
  priceKey
} from '../src/shared/usage-pricing'

const u = (over: Record<string, number> = {}) => ({
  promptTokens: 1_000_000,
  completionTokens: 500_000,
  totalTokens: 1_500_000,
  ...over
})

describe('computeUsageCost', () => {
  it('无缓存：输入+输出按单价除以 100 万', () => {
    // 1M × 2 + 0.5M × 4 = 2 + 2 = 4
    expect(computeUsageCost(u(), { input: 2, output: 4 })).toBe(4)
  })

  it('缓存命中部分按缓存单价（缓存价是输入价的子集）', () => {
    // 非缓存输入 0.8M × 2 + 缓存 0.2M × 0.5 + 输出 0.5M × 4 = 1.6 + 0.1 + 2 = 3.7
    expect(
      computeUsageCost(u({ promptTokens: 1_000_000, cachedTokens: 200_000 }), { input: 2, output: 4, cache: 0.5 })
    ).toBe(3.7)
  })

  it('缓存价留空时缓存部分按输入价计（等于无缓存费用）', () => {
    const withCache = computeUsageCost(u({ cachedTokens: 300_000 }), { input: 2, output: 4 })
    const withoutCache = computeUsageCost(u(), { input: 2, output: 4 })
    expect(withCache).toBe(withoutCache)
    expect(withCache).toBe(4)
  })

  it('cachedTokens 异常大于 prompt 时夹断，不产生负数', () => {
    // 夹到 prompt：全部按缓存价 1 计 + 输出 → 1M×1 + 0.5M×4 = 3
    const c = computeUsageCost(u({ promptTokens: 1_000_000, cachedTokens: 5_000_000 }), { input: 2, output: 4, cache: 1 })
    expect(c).toBe(3)
  })

  it('全 0 单价 → 0', () => {
    expect(computeUsageCost(u({ cachedTokens: 10 }), { input: 0, output: 0, cache: 0 })).toBe(0)
  })

  it('缺省/负 token 按 0 处理不产生 NaN', () => {
    const c = computeUsageCost(
      { promptTokens: -5, completionTokens: NaN as unknown as number, totalTokens: 0 },
      { input: 2, output: 4 }
    )
    expect(c).toBe(0)
  })

  it('结果按 6 位小数取整（浮点尾巴）', () => {
    // 333333 × 0.1 / 1e6 = 0.0333333
    const c = computeUsageCost({ promptTokens: 333_333, completionTokens: 0, totalTokens: 333_333 }, { input: 0.1, output: 0 })
    expect(c).toBe(roundCost(c))
    expect(c).toBe(0.033333)
  })
})

describe('parsePricing', () => {
  it('合法配置原样保留（含 cache=0）', () => {
    const p = parsePricing({
      currency: 'USD',
      prices: { 'openai::gpt-4o': { input: 2.5, output: 10, cache: 0 } }
    })
    expect(p.currency).toBe('USD')
    expect(p.prices['openai::gpt-4o']).toEqual({ input: 2.5, output: 10, cache: 0 })
  })

  it('currency 非白名单/缺失 → 回退 CNY', () => {
    expect(parsePricing({ currency: 'EUR', prices: {} }).currency).toBe('CNY')
    expect(parsePricing({ prices: {} }).currency).toBe('CNY')
  })

  it('整体入参非对象/null → 默认空配置', () => {
    expect(parsePricing(null)).toEqual({ currency: 'CNY', prices: {} })
    expect(parsePricing('x')).toEqual({ currency: 'CNY', prices: {} })
    expect(parsePricing(undefined)).toEqual({ currency: 'CNY', prices: {} })
  })

  it('prices 非对象 → 空价格表', () => {
    expect(parsePricing({ currency: 'CNY', prices: [] }).prices).toEqual({})
    expect(parsePricing({ currency: 'CNY', prices: 'x' }).prices).toEqual({})
  })

  it('非法条目整条丢弃：负数/NaN/字符串/缺 input 或 output', () => {
    const p = parsePricing({
      currency: 'CNY',
      prices: {
        'a::1': { input: -1, output: 2 },
        'a::2': { input: NaN, output: 2 },
        'a::3': { input: '1', output: '2' },
        'a::4': { output: 2 },
        'a::5': { input: 1 },
        'a::6': { input: 1, output: 2, cache: -0.1 },
        'ok::m': { input: 1, output: 2 }
      }
    })
    expect(Object.keys(p.prices)).toEqual(['ok::m'])
  })

  it('key 不含 :: 跳过', () => {
    const p = parsePricing({ prices: { 'badkey': { input: 1, output: 2 }, 'p::m': { input: 1, output: 2 } } })
    expect(Object.keys(p.prices)).toEqual(['p::m'])
  })

  it('cache 可省略；给了非数字才丢弃', () => {
    const p = parsePricing({ prices: { 'p::m': { input: 1, output: 2, cache: 0.25 } } })
    expect(p.prices['p::m']?.cache).toBe(0.25)
    const p2 = parsePricing({ prices: { 'p::m': { input: 1, output: 2 } } })
    expect(p2.prices['p::m']).toEqual({ input: 1, output: 2 })
  })
})

describe('sanitizeModelPrice / priceKey', () => {
  it('非对象/null → null', () => {
    expect(sanitizeModelPrice(null)).toBeNull()
    expect(sanitizeModelPrice('x')).toBeNull()
  })

  it('priceKey 用 :: 拼接', () => {
    expect(priceKey('anthropic', 'claude-3-5')).toBe('anthropic::claude-3-5')
  })

  it('PRICE_UNIT 为 100 万', () => {
    expect(PRICE_UNIT).toBe(1_000_000)
  })
})
