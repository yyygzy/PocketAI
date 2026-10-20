// @vitest-environment node
// 上下文窗口按 token 预算裁历史（V4-Iter-234）——纯函数侧
//
// 这批换掉的是一把用了很久的尺子：原来"每轮带多少历史"由**条数**决定（30 条），
// 而容量是按 token 算的。条数当尺子两头都不对：一条工具结果最多 2000 字符（≈500–2500 token），
// 30 条能堆到超过小窗口模型的容量；200k 上下文的云模型又被同样的 30 条白白卡住。
// 所以这里的判据全部围绕三件事：① 没声明窗口的模型**一条都不能变**（否则"没设过的用户行为变了"
// 这种话没人能反驳）；② 预算的扣项一个都不能少（提示词／工具面／输出预留／摘要预留）；
// ③ 裁的边界必须落在轮与轮之间——从中间切开一轮，那一轮的工具结果就成了悬空应答。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => ({ streamChat: async () => ({ content: '' }) }) }
}))
vi.mock('../src/main/knowledge/rag', () => ({
  ragService: { retrieve: async () => ({ chunks: [] }), buildContext: () => '' }
}))
vi.mock('../src/main/tools/registry', () => ({
  toolRegistry: {
    filterByPermissions: () => [],
    list: () => [],
    formatForPrompt: () => '',
    execute: async () => ({ content: '', isError: false })
  }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  estimateAdapterMessageTokens,
  estimateTokens,
  groupHistoryByTurn,
  planHistoryWindow
} from '../src/main/agent/engine'
import { DEFAULT_MESSAGES_WHEN_WINDOW_UNSET } from '../src/shared/model-window'
import type { MessageRecord, ToolSchema } from '../src/shared/types'

/** 只填被测函数会用到的字段；status 一律 done（buildContext 会跳过非 done） */
function rec(id: string, role: MessageRecord['role'], content: string, extra: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id,
    conversationId: 'c1',
    role,
    content,
    provider: 'p1',
    model: 'm1',
    status: 'done',
    parentId: null,
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    ...extra
  } as MessageRecord
}

/** 一轮完整工具调用：user → assistant(tool_calls) → tool → assistant(最终话) */
function toolTurn(n: number, toolPayload: string): MessageRecord[] {
  const callId = `call-${n}`
  return [
    rec(`u${n}`, 'user', `第 ${n} 问：帮我看下文件`),
    rec(`a${n}`, 'assistant', '', {
      toolCalls: JSON.stringify([{ id: callId, type: 'function', function: { name: 'fs_read', arguments: '{\"path\":\"a.md\"}' } }])
    }),
    rec(`t${n}`, 'tool', JSON.stringify({ toolCallId: callId, name: 'fs_read', content: toolPayload, isError: false })),
    rec(`f${n}`, 'assistant', `第 ${n} 答：看到了`)
  ]
}

function turns(count: number, eachChars = 40): MessageRecord[] {
  const out: MessageRecord[] = []
  for (let i = 1; i <= count; i++) {
    out.push(rec(`u${i}`, 'user', '问'.repeat(eachChars)))
    out.push(rec(`a${i}`, 'assistant', '答'.repeat(eachChars)))
  }
  return out
}

const SYSTEM = '你是助手'
const NO_TOOLS: ToolSchema[] = []
/** 与引擎里那两个预留常量对齐的字面量：改这两个数必须是有意的一次改动，不该被算术悄悄带走 */
const OUTPUT_RESERVE = 4096
const SUMMARY_RESERVE = 1500

describe('① 没声明窗口的模型：一条都不许变', () => {
  it('35 条历史 ⇒ 带最近 30 条、早期 5 条进摘要（与改动前的切片逐条相同）', () => {
    const all = turns(18) // 36 条
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: null })
    expect(plan.source).toBe('default')
    expect(plan.windowed.map((m) => m.id)).toEqual(all.slice(-DEFAULT_MESSAGES_WHEN_WINDOW_UNSET).map((m) => m.id))
    expect(plan.early.map((m) => m.id)).toEqual(all.slice(0, all.length - DEFAULT_MESSAGES_WHEN_WINDOW_UNSET).map((m) => m.id))
    expect(plan.budgetTokens).toBeNull()
    expect(plan.noRoom).toBe(false)
  })

  it('反向对照：28 条（没超过 30）⇒ 全带、early 空', () => {
    const all = turns(14)
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: null })
    expect(plan.windowed).toHaveLength(28)
    expect(plan.early).toEqual([])
  })

  it('0 条历史也不炸（新建会话第一轮）', () => {
    const plan = planHistoryWindow({ allHistory: [], systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: null })
    expect(plan.windowed).toEqual([])
    expect(plan.early).toEqual([])
  })
})

describe('② 预算的扣项：少扣一项就会多塞一项', () => {
  it('budget = 声明值 −（提示词 + 工具面）− 输出预留 − 摘要预留，逐项都扣到了', () => {
    const tools = [{ id: 'fs_read', name: 'fs_read', description: '读文件', parameters: { type: 'object' } }] as unknown as ToolSchema[]
    const declared = 10_000
    const staticTokens = estimateTokens(SYSTEM) + estimateTokens(JSON.stringify(tools))
    const plan = planHistoryWindow({ allHistory: turns(3), systemPrompt: SYSTEM, tools, declaredTokens: declared })
    expect(plan.budgetTokens).toBe(declared - staticTokens - OUTPUT_RESERVE - SUMMARY_RESERVE)
    expect(plan.source).toBe('declared')
  })

  it('提示词变长 ⇒ 预算变小（这一项真的在算，不是摆设）', () => {
    const base = planHistoryWindow({ allHistory: turns(3), systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 9000 })
    const long = planHistoryWindow({
      allHistory: turns(3),
      systemPrompt: SYSTEM + '工'.repeat(4000),
      tools: NO_TOOLS,
      declaredTokens: 9000
    })
    expect(long.budgetTokens).toBeLessThan(base.budgetTokens as number)
  })
})

describe('③ 按轮装：放开与收紧', () => {
  it('声明 200k ⇒ 带得下远超 30 条的历史（这是"放开"那一半）', () => {
    const all = turns(40) // 80 条，全部带得动
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 200_000 })
    expect(plan.windowed.length).toBeGreaterThan(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET)
    expect(plan.windowed).toHaveLength(80)
    expect(plan.early).toEqual([])
  })

  it('条数硬上限 120：声明再大也只带到 120 条（预算放开的是"比 30 更多"，不是整本日志重发）', () => {
    const plan = planHistoryWindow({ allHistory: turns(100), systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 4_000_000 })
    expect(plan.windowed).toHaveLength(120)
  })

  it('声明很小 ⇒ 只带最新一轮，其余全进 early（收紧那一半）', () => {
    // 每条 100 个 CJK ⇒ 一轮正好 200 token；预算给 250 ⇒ 装得下一轮、装不下两轮（这是确定值不是估计）
    const all = turns(10, 100)
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 5850 })
    expect(plan.windowed.map((m) => m.id)).toEqual(['u10', 'a10'])
    expect(plan.early).toHaveLength(18)
    expect(plan.noRoom).toBe(false)
  })

  it('装不下（固定开销已经超过声明值）⇒ noRoom 如实报，但仍然带上最新一轮——不能把用户的问题裁掉', () => {
    const all = turns(6)
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 1000 })
    expect(plan.noRoom).toBe(true)
    expect(plan.budgetTokens).toBeLessThanOrEqual(0)
    expect(plan.windowed.map((m) => m.id)).toEqual(['u6', 'a6'])
  })

  it('不变式：early + windowed == 原历史，不丢不重也不换序（每个分支各跑一遍）', () => {
    for (const declared of [null, 1000, 5900, 60_000, 4_000_000]) {
      const all = turns(30)
      const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: declared })
      expect([...plan.early, ...plan.windowed].map((m) => m.id)).toEqual(all.map((m) => m.id))
    }
  })
})

describe('④ 边界只落在轮与轮之间', () => {
  it('一轮 user→assistant(tool_calls)→tool→assistant 是**一组**：装不下也得整组带上、不许切开', () => {
    const all = [...toolTurn(1, 'x'.repeat(4000)), ...toolTurn(2, 'y'.repeat(20))]
    expect(groupHistoryByTurn(all).map((g) => g.length)).toEqual([4, 4])
    // 预算 20 token：比任何一轮都小 ⇒ 最新那轮照样整组带上（第一组无条件），
    // 而早一轮只要有一点点量就装不下 ⇒ 判据不依赖"那一轮到底估出多少"
    const plan = planHistoryWindow({ allHistory: all, systemPrompt: SYSTEM, tools: NO_TOOLS, declaredTokens: 5620 })
    expect(plan.windowed.map((m) => m.id)).toEqual(['u2', 'a2', 't2', 'f2'])
    // 真判据是"组不许被切开"，不是"被切掉的那段里没有工具结果"——整组被切掉时早期段里当然有 tool
    for (const g of groupHistoryByTurn(all)) {
      const kept = plan.windowed.filter((m) => g.some((x) => x.id === m.id)).length
      expect(kept === g.length || kept === 0, `组 ${g[0]?.id} 被切开：${kept}/${g.length}`).toBe(true)
    }
  })

  it('首条 user 之前的记录自成一组，不会静默丢（不变式那条也覆盖）', () => {
    const all = [rec('x1', 'assistant', '开场白'), ...turns(2)]
    expect(groupHistoryByTurn(all).map((g) => g.map((m) => m.id))).toEqual([['x1'], ['u1', 'a1'], ['u2', 'a2']])
  })
})

describe('⑤ 估算本身', () => {
  it('图片按固定额度算，**不按 base64 长度**：一张 1MB 的图不该把整段历史挤光', () => {
    const small = { role: 'user' as const, content: [
      { type: 'text' as const, text: '看图' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100) } }
    ] }
    const huge = { role: 'user' as const, content: [
      { type: 'text' as const, text: '看图' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200_000) } }
    ] }
    const a = estimateAdapterMessageTokens(small)
    const b = estimateAdapterMessageTokens(huge)
    expect(a).toBe(b)
    // 文本那半照旧按 estimateTokens 算（CJK 1 字/token：「看图」=2），图片给固定额度
    expect(a).toBe(estimateTokens('看图') + 1024)
  })

  it('assistant 的 tool_calls 参数也计入（只算 content 会低估一整轮）', () => {
    const bare = estimateAdapterMessageTokens({ role: 'assistant', content: '' })
    const withCall = estimateAdapterMessageTokens({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'a.md', content: 'x'.repeat(800) }) } }]
    })
    expect(withCall).toBeGreaterThan(bare)
  })
})
