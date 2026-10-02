// usage-service 用量聚合测试
//
// 覆盖 src/main/usage/usage-service.ts 纯函数：
// - parseUsageJson：正常/缺字段/负数/坏 JSON 容错
// - localDateKey：本地时区切日
// - aggregateUsage：汇总/按日补零/按 provider/模型聚合/Top10 截断
// - aggregateConversationUsage：会话维度分组/标题兜底/费用
// - aggregateAssistantUsage：助手维度分组/名称兜底/费用
import { describe, it, expect, vi } from 'vitest'

// mock dbService 所在模块（usage-service 顶部 import 链会加载 database.ts → electron）
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))

import { parseUsageJson, localDateKey, aggregateUsage, aggregateConversationUsage, aggregateAssistantUsage, aggregateUsageDetail, type UsageRow, type UsageConversationRow, type UsageAssistantRow, type UsageDetailRow } from '../src/main/usage/usage-service'

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
    expect(s.totals).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0 })
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

  it('传入价格表时 totals/daily/byModel 正确计费用', () => {
    const today = new Date()
    const d1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 10, 0).getTime() // 昨天
    const prices = {
      // 默认行 openai/gpt-4o（100 prompt/50 completion）：(100×2 + 50×4)/1e6 = 0.0004
      'openai::gpt-4o': { input: 2, output: 4 },
      // anthropic/claude-sonnet（200 prompt 含 50 缓存/200 completion）：
      // (150×2 + 50×0.4 + 200×4)/1e6 = (300 + 20 + 800)/1e6 = 0.00112
      'anthropic::claude-sonnet': { input: 2, output: 4, cache: 0.4 }
    }
    const s = aggregateUsage([
      row({ created_at: d1 }),
      row({
        created_at: d1,
        provider: 'anthropic',
        model: 'claude-sonnet',
        usage: JSON.stringify({ promptTokens: 200, completionTokens: 200, totalTokens: 400, cachedTokens: 50 })
      })
    ], 5, prices)
    expect(s.totals.cost).toBe(0.00152)
    expect(s.byModel.find((m) => m.model === 'gpt-4o')?.cost).toBe(0.0004)
    expect(s.byModel.find((m) => m.model === 'claude-sonnet')?.cost).toBe(0.00112)
    // daily 费用并入发生日（昨天），其余补零日 cost=0
    const usedDay = s.daily.find((d) => d.date === localDateKey(d1))
    expect(usedDay?.cost).toBe(0.00152)
    expect(s.daily.filter((d) => d.date !== localDateKey(d1)).every((d) => d.cost === 0)).toBe(true)
  })

  it('未配置单价的模型 cost=0 且 token 统计不变；byProvider 费用=其模型费用之和', () => {
    const s = aggregateUsage([
      row({ provider: 'openai', model: 'gpt-4o' }),
      row({ provider: 'openai', model: 'gpt-4o-mini' })
    ], 3, { 'openai::gpt-4o': { input: 2, output: 4 } })
    expect(s.totals.cost).toBe(0.0004) // 仅 gpt-4o 计价
    expect(s.totals.totalTokens).toBe(300) // 两条都计数
    expect(s.byModel.find((m) => m.model === 'gpt-4o-mini')?.cost).toBe(0)
    const openai = s.byProvider.find((p) => p.provider === 'openai')
    expect(openai?.cost).toBe(0.0004)
    expect(openai?.totalTokens).toBe(300)
  })
})

describe('aggregateConversationUsage', () => {
  const convRow = (over: Partial<UsageConversationRow> = {}): UsageConversationRow => ({
    conversation_id: 'c1',
    title: '会话一',
    provider: 'openai',
    model: 'gpt-4o',
    usage: JSON.stringify({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
    created_at: Date.now(),
    ...over
  })

  it('多会话分组聚合：requests/totalTokens 累加，按 totalTokens 倒序，lastUsedAt 取最大', () => {
    const now = Date.now()
    const items = aggregateConversationUsage([
      convRow({ conversation_id: 'c1', title: '会话一', created_at: now - 1000 }),
      convRow({ conversation_id: 'c1', title: '会话一', created_at: now }), // 同会话第二条
      convRow({ conversation_id: 'c2', title: '会话二', usage: JSON.stringify({ promptTokens: 400, completionTokens: 400, totalTokens: 800 }), created_at: now })
    ])
    expect(items).toHaveLength(2)
    expect(items[0]!.conversationId).toBe('c2') // 800 > 300
    expect(items[0]!.totalTokens).toBe(800)
    expect(items[1]!.conversationId).toBe('c1')
    expect(items[1]!.requests).toBe(2)
    expect(items[1]!.totalTokens).toBe(300)
    expect(items[1]!.lastUsedAt).toBe(now)
  })

  it('标题取 JOIN 值；NULL/空串兜底 (未知会话)，同会话首行无标题后行有时取非空', () => {
    const items = aggregateConversationUsage([
      convRow({ conversation_id: 'c1', title: null }),
      convRow({ conversation_id: 'c2', title: '  ' }),
      convRow({ conversation_id: 'c3', title: null, created_at: 1 }),
      convRow({ conversation_id: 'c3', title: '后到的标题', created_at: 2 })
    ])
    const byId = new Map(items.map((i) => [i.conversationId, i]))
    expect(byId.get('c1')?.title).toBe('(未知会话)')
    expect(byId.get('c2')?.title).toBe('(未知会话)')
    expect(byId.get('c3')?.title).toBe('后到的标题')
  })

  it('坏 usage 行跳过不计数', () => {
    const items = aggregateConversationUsage([
      convRow({ usage: 'broken' }),
      convRow({ usage: null }),
      convRow()
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.requests).toBe(1)
    expect(items[0]!.totalTokens).toBe(150)
  })

  it('conversation_id 为空 → (未知会话) 分组不崩', () => {
    const items = aggregateConversationUsage([convRow({ conversation_id: '' })])
    expect(items[0]!.conversationId).toBe('(未知会话)')
  })

  it('配置单价时费用正确，未配置模型 cost=0', () => {
    const prices = { 'openai::gpt-4o': { input: 2, output: 4 } } // (100×2+50×4)/1e6 = 0.0004
    const items = aggregateConversationUsage([
      convRow({ conversation_id: 'c1', title: '计价会话' }),
      convRow({ conversation_id: 'c2', title: '未配价会话', model: 'gpt-4o-mini' })
    ], prices)
    const byId = new Map(items.map((i) => [i.conversationId, i]))
    expect(byId.get('c1')?.cost).toBe(0.0004)
    expect(byId.get('c2')?.cost).toBe(0)
    expect(byId.get('c2')?.totalTokens).toBe(150)
  })
})

describe('aggregateAssistantUsage', () => {
  const asstRow = (over: Partial<UsageAssistantRow> = {}): UsageAssistantRow => ({
    assistant_id: 'a1',
    name: '写作助手',
    provider: 'openai',
    model: 'gpt-4o',
    usage: JSON.stringify({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }),
    created_at: Date.now(),
    ...over
  })

  it('多助手分组聚合：requests/totalTokens 累加，按 totalTokens 倒序，lastUsedAt 取最大', () => {
    const now = Date.now()
    const items = aggregateAssistantUsage([
      asstRow({ assistant_id: 'a1', name: '写作助手', created_at: now - 1000 }),
      asstRow({ assistant_id: 'a1', name: '写作助手', created_at: now }), // 同助手第二条
      asstRow({ assistant_id: 'a2', name: '翻译助手', usage: JSON.stringify({ promptTokens: 400, completionTokens: 400, totalTokens: 800 }), created_at: now })
    ])
    expect(items).toHaveLength(2)
    expect(items[0]!.assistantId).toBe('a2') // 800 > 300
    expect(items[0]!.totalTokens).toBe(800)
    expect(items[1]!.assistantId).toBe('a1')
    expect(items[1]!.requests).toBe(2)
    expect(items[1]!.totalTokens).toBe(300)
    expect(items[1]!.lastUsedAt).toBe(now)
  })

  it('名称取 JOIN 值；NULL/空串/assistant_id 空 兜底 (未知助手)，同助手首行无名后行有时取非空', () => {
    const items = aggregateAssistantUsage([
      asstRow({ assistant_id: 'a1', name: null }),
      asstRow({ assistant_id: 'a2', name: '  ' }),
      asstRow({ assistant_id: '', name: '孤儿消息' }), // assistant_id 空 → id 也走兜底
      asstRow({ assistant_id: 'a3', name: null, created_at: 1 }),
      asstRow({ assistant_id: 'a3', name: '后到的名称', created_at: 2 })
    ])
    const byId = new Map(items.map((i) => [i.assistantId, i]))
    expect(byId.get('a1')?.name).toBe('(未知助手)')
    expect(byId.get('a2')?.name).toBe('(未知助手)')
    expect(byId.get('(未知助手)')?.name).toBe('孤儿消息') // assistant_id 空与无名共享兜底组
    expect(byId.get('a3')?.name).toBe('后到的名称')
  })

  it('坏 usage 行跳过不计数', () => {
    const items = aggregateAssistantUsage([
      asstRow({ usage: 'broken' }),
      asstRow({ usage: null }),
      asstRow()
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.requests).toBe(1)
    expect(items[0]!.totalTokens).toBe(150)
  })

  it('配置单价时费用正确，未配置模型 cost=0', () => {
    const prices = { 'openai::gpt-4o': { input: 2, output: 4 } } // (100×2+50×4)/1e6 = 0.0004
    const items = aggregateAssistantUsage([
      asstRow({ assistant_id: 'a1', name: '计价助手' }),
      asstRow({ assistant_id: 'a2', name: '未配价助手', model: 'gpt-4o-mini' })
    ], prices)
    const byId = new Map(items.map((i) => [i.assistantId, i]))
    expect(byId.get('a1')?.cost).toBe(0.0004)
    expect(byId.get('a2')?.cost).toBe(0)
    expect(byId.get('a2')?.totalTokens).toBe(150)
  })
})

describe('aggregateUsageDetail', () => {
  const detailRow = (over: Partial<UsageDetailRow> = {}): UsageDetailRow => ({
    provider: 'openai',
    model: 'gpt-4o',
    usage: JSON.stringify({ promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 20 }),
    created_at: Date.now(),
    conversation_id: 'c1',
    conversation_title: '测试会话',
    assistant_id: 'a1',
    assistant_name: '写作助手',
    ...over
  })

  it('空行 → 空数组', () => {
    expect(aggregateUsageDetail([])).toEqual([])
  })

  it('JOIN 行拆出明细字段，保持入参顺序不重排', () => {
    const t1 = Date.now() - 1000
    const t2 = Date.now()
    const items = aggregateUsageDetail([
      detailRow({ created_at: t1, model: 'older' }),
      detailRow({ created_at: t2, model: 'newer' })
    ])
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.model)).toEqual(['older', 'newer'])
    expect(items[0]).toMatchObject({
      conversationId: 'c1', conversationTitle: '测试会话',
      assistantId: 'a1', assistantName: '写作助手',
      provider: 'openai', promptTokens: 100, completionTokens: 50, cachedTokens: 20, totalTokens: 150
    })
  })

  it('坏 usage 行跳过', () => {
    const items = aggregateUsageDetail([
      detailRow({ usage: 'broken' }),
      detailRow({ usage: null }),
      detailRow()
    ])
    expect(items).toHaveLength(1)
    expect(items[0]!.totalTokens).toBe(150)
  })

  it('cachedTokens 缺省时计 0；provider/model/标题为空时兜底', () => {
    const items = aggregateUsageDetail([
      detailRow({
        usage: JSON.stringify({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
        provider: null, model: null,
        conversation_id: '', conversation_title: '  ',
        assistant_id: null, assistant_name: null
      })
    ])
    expect(items[0]).toMatchObject({
      provider: '(未知)', model: '(未知)', conversationId: '(未知会话)', conversationTitle: '(未知会话)',
      assistantId: null, assistantName: null, cachedTokens: 0
    })
  })

  it('配置单价时费用正确并 roundCost，未配置模型 cost=0', () => {
    const prices = { 'openai::gpt-4o': { input: 2, output: 4 } } // (100×2+50×4)/1e6 = 0.0004
    const items = aggregateUsageDetail([
      detailRow(),
      detailRow({ model: 'gpt-4o-mini' })
    ], prices)
    expect(items[0]!.cost).toBe(0.0004)
    expect(items[1]!.cost).toBe(0)
  })
})
