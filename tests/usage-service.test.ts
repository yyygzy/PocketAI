// usage-service 用量聚合测试
//
// 覆盖 src/main/usage/usage-service.ts 纯函数：
// - parseUsageJson：正常/缺字段/负数/坏 JSON 容错
// - localDateKey：本地时区切日
// - aggregateUsage：汇总/按日补零/按 provider/模型聚合/Top10 截断
import { describe, it, expect, vi } from 'vitest'

// mock dbService 所在模块（usage-service 顶部 import 链会加载 database.ts → electron）
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))

import { parseUsageJson, localDateKey, aggregateUsage, type UsageRow } from '../src/main/usage/usage-service'

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  provider: 'openai',
  model: 'gpt-4o',
  usage: JSON.stringify({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
  // 默认今天（聚合按「最近 N 天」补零，固定历史日期会落在范围外被跳过）
  created_at: Date.now(),
  ...over
})

describe('parseUsageJson', () => {
  it('正常解析', () => {
    expect(parseUsageJson('{"promptTokens":10,"completionTokens":5,"totalTokens":15}')).toEqual({
      promptTokens: 10, completionTokens: 5, totalTokens: 15
    })
  })
  it('cachedTokens > 0 时保留', () => {
    const u = parseUsageJson('{"promptTokens":10,"completionTokens":5,"totalTokens":15,"cachedTokens":8}')
    expect(u?.cachedTokens).toBe(8)
  })
  it('cachedTokens 缺失/为 0 时不带该字段', () => {
    expect(parseUsageJson('{"promptTokens":1,"completionTokens":1,"totalTokens":2,"cachedTokens":0}')).not.toHaveProperty('cachedTokens')
    expect(parseUsageJson('{"promptTokens":1,"completionTokens":1,"totalTokens":2}')).not.toHaveProperty('cachedTokens')
  })
  it('缺字段 → null', () => {
    expect(parseUsageJson('{"promptTokens":10}')).toBeNull()
  })
  it('负数 → null', () => {
    expect(parseUsageJson('{"promptTokens":-1,"completionTokens":5,"totalTokens":4}')).toBeNull()
  })
  it('非有限数 → null', () => {
    expect(parseUsageJson('{"promptTokens":"x","completionTokens":5,"totalTokens":4}')).toBeNull()
  })
  it('坏 JSON / null 输入 → null', () => {
    expect(parseUsageJson('not-json')).toBeNull()
    expect(parseUsageJson(null)).toBeNull()
  })
})

describe('localDateKey', () => {
  it('按本地时区格式化为 YYYY-MM-DD', () => {
    const ts = new Date(2026, 8, 20, 9, 30).getTime() // 本地 2026-09-20 09:30
    expect(localDateKey(ts)).toBe('2026-09-20')
  })
  it('补零', () => {
    const ts = new Date(2026, 0, 5, 0, 0).getTime() // 本地 2026-01-05
    expect(localDateKey(ts)).toBe('2026-01-05')
  })
})

describe('aggregateUsage', () => {
  it('空行 → 全零汇总 + daily 补零填充 days 天', () => {
    const s = aggregateUsage([], 7)
    expect(s.totals).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 })
    expect(s.daily).toHaveLength(7)
    expect(s.daily.every((d) => d.totalTokens === 0)).toBe(true)
    expect(s.byProvider).toEqual([])
    expect(s.byModel).toEqual([])
  })

  it('多行聚合：汇总/daily/byProvider/byModel', () => {
    const today = new Date()
    const d1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 10, 0).getTime() // 昨天
    const d2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2, 10, 0).getTime() // 前天
    const key = (ts: number) => localDateKey(ts)
    const days = 5
    const s = aggregateUsage([
      row({ created_at: d1 }),
      row({ created_at: d1, provider: 'anthropic', model: 'claude-sonnet', usage: JSON.stringify({ promptTokens: 200, completionTokens: 200, totalTokens: 400, cachedTokens: 50 }) }),
      row({ created_at: d2, model: 'gpt-4o-mini' })
    ], days)
    expect(s.days).toBe(days)
    expect(s.totals.requests).toBe(3)
    expect(s.totals.promptTokens).toBe(100 + 200 + 100)
    expect(s.totals.completionTokens).toBe(50 + 200 + 50)
    expect(s.totals.totalTokens).toBe(150 + 400 + 150)
    expect(s.totals.cachedTokens).toBe(50)
    // daily 汇总（补零后共 5 天）
    const yesterday = s.daily.find((d) => d.date === key(d1))
    const dayBefore = s.daily.find((d) => d.date === key(d2))
    expect(yesterday?.totalTokens).toBe(550)
    expect(dayBefore?.totalTokens).toBe(150)
    // byProvider 按 totalTokens 降序
    expect(s.byProvider[0]?.provider).toBe('anthropic')
    expect(s.byProvider[1]?.provider).toBe('openai')
    // byModel
    expect(s.byModel.find((m) => m.model === 'claude-sonnet')?.totalTokens).toBe(400)
  })

  it('补零范围外的行整体跳过（totals 口径与 daily 一致）', () => {
    const old = new Date(2020, 0, 1, 10, 0).getTime()
    const s = aggregateUsage([row({ created_at: old })], 7)
    expect(s.totals.requests).toBe(0)
    expect(s.byProvider).toEqual([])
  })

  it('坏 usage 行跳过不计数', () => {
    const s = aggregateUsage([
      row({ usage: 'broken' }),
      row({ usage: null }),
      row({ usage: JSON.stringify({ promptTokens: -1, completionTokens: 1, totalTokens: 0 }) }),
      row()
    ], 3)
    expect(s.totals.requests).toBe(1)
    expect(s.totals.totalTokens).toBe(150)
  })

  it('provider/model 为 null → (未知) 分组', () => {
    const s = aggregateUsage([row({ provider: null, model: null })], 3)
    expect(s.byProvider[0]?.provider).toBe('(未知)')
    expect(s.byModel[0]?.model).toBe('(未知)')
  })

  it('byModel Top10 截断，byProvider 不截断', () => {
    const rows: UsageRow[] = Array.from({ length: 12 }, (_, i) =>
      row({ model: `model-${i}`, usage: JSON.stringify({ promptTokens: 10, completionTokens: 10, totalTokens: 100 + i }) })
    )
    const s = aggregateUsage(rows, 3)
    expect(s.byModel).toHaveLength(10)
    // 降序：最高分 model-11 在前
    expect(s.byModel[0]?.model).toBe('model-11')
    expect(s.byProvider).toHaveLength(1)
  })
})
