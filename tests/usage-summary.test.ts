// 会话级用量汇总纯函数测试（ChatView 会话累计用量条）
import { describe, it, expect } from 'vitest'
import type { MessageRecord, UsagePricing, UsageStats } from '../src/shared/types'
import { sumMessagesUsage } from '../src/renderer/src/utils/usage-summary'

function msg(partial: {
  role?: 'user' | 'assistant'
  usage?: UsageStats | null
  provider?: string | null
  model?: string | null
}): MessageRecord {
  return {
    id: 'm',
    conversationId: 'c',
    role: partial.role ?? 'assistant',
    content: '',
    provider: partial.provider ?? null,
    model: partial.model ?? null,
    status: 'done',
    parentId: null,
    createdAt: 0,
    usage: partial.usage ?? null
  } as MessageRecord
}

function u(promptTokens: number, completionTokens: number, cachedTokens?: number): UsageStats {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {})
  }
}

const pricing: UsagePricing = {
  currency: 'CNY',
  prices: {
    'p1::m1': { input: 10, output: 30 },
    'p1::m2': { input: 2, output: 8, cache: 0.5 }
  }
}

describe('sumMessagesUsage — token 汇总', () => {
  it('空会话全 0', () => {
    expect(sumMessagesUsage([])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      cost: 0,
      counted: 0
    })
  })

  it('只汇总 assistant：user 消息与无 usage 消息跳过，counted 准确', () => {
    const s = sumMessagesUsage([
      msg({ role: 'user', usage: u(999, 999) }),
      msg({ usage: u(100, 200, 50) }),
      msg({ usage: null }),
      msg({ usage: u(10, 20) })
    ])
    expect(s.promptTokens).toBe(110)
    expect(s.completionTokens).toBe(220)
    expect(s.cachedTokens).toBe(50)
    expect(s.totalTokens).toBe(330)
    expect(s.counted).toBe(2)
  })

  it('无 pricing 时只出 token，cost 为 0', () => {
    const s = sumMessagesUsage([msg({ provider: 'p1', model: 'm1', usage: u(100, 200) })])
    expect(s.cost).toBe(0)
  })
})

describe('sumMessagesUsage — 费用', () => {
  it('命中单价：100k 输入 ¥10/M + 200k 输出 ¥30/M = ¥7', () => {
    const s = sumMessagesUsage(
      [msg({ provider: 'p1', model: 'm1', usage: u(100_000, 200_000) })],
      pricing
    )
    expect(s.cost).toBe(7)
  })

  it('多条、多模型各自单价求和（含缓存价）', () => {
    // m1: 100k 输入 ¥1 + 200k 输出 ¥6 = 7
    // m2: 1M 输入中 800k 非缓存 ¥1.6 + 200k 缓存 ¥0.1 + 500k 输出 ¥4 = 5.7
    const s = sumMessagesUsage(
      [
        msg({ provider: 'p1', model: 'm1', usage: u(100_000, 200_000) }),
        msg({ provider: 'p1', model: 'm2', usage: u(1_000_000, 500_000, 200_000) })
      ],
      pricing
    )
    expect(s.cost).toBe(12.7)
  })

  it('单价缺失或无 provider/model：token 照计，费用 0', () => {
    const s = sumMessagesUsage(
      [
        msg({ provider: 'p1', model: 'unknown', usage: u(100, 200) }),
        msg({ provider: null, model: 'm1', usage: u(300, 400) })
      ],
      pricing
    )
    expect(s.totalTokens).toBe(1000)
    expect(s.cost).toBe(0)
  })
})
