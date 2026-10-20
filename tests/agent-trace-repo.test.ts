// agentTraceRepo.latestStatsByConversation 测试
//
// 用内存 SQLite 验证「会话最近一次运行」聚合：
// - 无 trace → null
// - 单次运行多步 → 耗时/token 求和、步数计数（NULL 列按 SUM 忽略处理）
// - 同会话多次运行 → 只取 created_at 最新所属 requestId 的数据
// - 会话间严格隔离
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mem = new Database(':memory:')
mem.exec(`
  CREATE TABLE agent_traces (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    parent_request_id TEXT,
    step_index INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    tool_name TEXT,
    duration_ms INTEGER,
    token_usage INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    status TEXT,
    error TEXT,
    tool_args TEXT,
    tool_result TEXT,
    model TEXT,
    created_at INTEGER
  )
`)

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => mem } }))

import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'

beforeEach(() => {
  mem.prepare('DELETE FROM agent_traces').run()
})

describe('agentTraceRepo.latestStatsByConversation', () => {
  it('会话无任何 trace → null', () => {
    expect(agentTraceRepo.latestStatsByConversation('empty')).toBeNull()
  })

  it('单次运行多步 → 耗时/token 求和、步数计数', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 1200, tokenUsage: 100, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 1, stepType: 'tools', toolName: 'time_now', durationMs: 30, tokenUsage: undefined, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 2, stepType: 'final', durationMs: 800, tokenUsage: 50, status: 'success' })
    // insert 自动写 created_at=Date.now()，r1 全部成为最新运行
    expect(agentTraceRepo.latestStatsByConversation('c1')).toEqual({
      totalDurationMs: 2030,
      totalTokens: 150,
      stepCount: 3
    })
  })

  it('同会话多次运行 → 仅聚合 created_at 最新的那次 requestId', () => {
    // 旧运行：3 步，数字偏大
    agentTraceRepo.insert({ requestId: 'old', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 5000, tokenUsage: 999, status: 'success' })
    agentTraceRepo.insert({ requestId: 'old', conversationId: 'c1', stepIndex: 1, stepType: 'tools', durationMs: 5000, tokenUsage: 999, status: 'success' })
    agentTraceRepo.insert({ requestId: 'old', conversationId: 'c1', stepIndex: 2, stepType: 'final', durationMs: 5000, tokenUsage: 999, status: 'success' })
    // 新运行：2 步（后插入 created_at 更大）
    agentTraceRepo.insert({ requestId: 'new', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 1000, tokenUsage: 10, status: 'success' })
    agentTraceRepo.insert({ requestId: 'new', conversationId: 'c1', stepIndex: 1, stepType: 'final', durationMs: 2000, tokenUsage: 20, status: 'success' })

    expect(agentTraceRepo.latestStatsByConversation('c1')).toEqual({
      totalDurationMs: 3000,
      totalTokens: 30,
      stepCount: 2
    })
  })

  it('其他会话的 trace 不影响本会话结果', () => {
    agentTraceRepo.insert({ requestId: 'rA', conversationId: 'cA', stepIndex: 0, stepType: 'llm', durationMs: 100, tokenUsage: 1, status: 'success' })
    agentTraceRepo.insert({ requestId: 'rB', conversationId: 'cB', stepIndex: 0, stepType: 'llm', durationMs: 200, tokenUsage: 2, status: 'success' })
    agentTraceRepo.insert({ requestId: 'rB2', conversationId: 'cB', stepIndex: 0, stepType: 'final', durationMs: 300, tokenUsage: 3, status: 'success' })

    expect(agentTraceRepo.latestStatsByConversation('cA')).toEqual({
      totalDurationMs: 100,
      totalTokens: 1,
      stepCount: 1
    })
  })

  it('全部步聚缺耗时/token（NULL）→ 指标为 0，仍返回统计', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'llm', status: 'success' })
    expect(agentTraceRepo.latestStatsByConversation('c1')).toEqual({
      totalDurationMs: 0,
      totalTokens: 0,
      stepCount: 1
    })
  })
})

// V4-Iter-163（用户选定口径）：**token 按整棵编排树算，步数与耗时只算主干**。
// 依据是 162 的真机实测：界面写「3 步 · 94.0s · 6,736 tokens」，而这趟实际烧了 9,833（差的 3,097 在云端子代理身上）。
// 耗时不能跟着加：父那一步 `delegate_task` 的 duration 物理上包住了整段子 run。
describe('本次运行的统计按整棵树算 token（父 + 直接子，一层）', () => {
  it('有子 run：token 含子，步数/耗时不含，childRuns 报得出次数', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 33000, tokenUsage: 3192, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 1, stepType: 'tools', toolName: 'delegate_task', durationMs: 38800, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 2, stepType: 'final', durationMs: 21900, tokenUsage: 3544, status: 'success' })
    // 子 run：自己的 request + 自己的会话，只有 parent_request_id 指回控制器
    agentTraceRepo.insert({ requestId: 'r-child', conversationId: 'c-child', parentRequestId: 'r1', stepIndex: 0, stepType: 'final', durationMs: 19200, tokenUsage: 3097, status: 'success' })

    expect(agentTraceRepo.latestStatsByConversation('c1')).toEqual({
      totalDurationMs: 93700, // 33000 + 38800 + 21900：子的 19200 不加第二遍
      totalTokens: 9833, // 3192 + 3544 + 3097：子的一分不落
      stepCount: 3, // 界面上能数到的还是这三步
      childRuns: 1
    })
  })

  it('两次子 run 就是 childRuns=2，token 两份都算', () => {
    agentTraceRepo.insert({ requestId: 'r2', conversationId: 'c2', stepIndex: 0, stepType: 'llm', durationMs: 10, tokenUsage: 100, status: 'success' })
    agentTraceRepo.insert({ requestId: 'rc1', conversationId: 'c2k1', parentRequestId: 'r2', stepIndex: 0, stepType: 'final', durationMs: 500, tokenUsage: 40, status: 'success' })
    agentTraceRepo.insert({ requestId: 'rc2', conversationId: 'c2k2', parentRequestId: 'r2', stepIndex: 0, stepType: 'final', durationMs: 700, tokenUsage: 60, status: 'success' })

    expect(agentTraceRepo.statsByRequest('r2')).toEqual({
      totalDurationMs: 10,
      totalTokens: 200,
      stepCount: 1,
      childRuns: 2
    })
  })

  it('反向对照：没有子 run 时数字与形状都不许变（childRuns 干脆不给键）', () => {
    agentTraceRepo.insert({ requestId: 'r3', conversationId: 'c3', stepIndex: 0, stepType: 'llm', durationMs: 100, tokenUsage: 7, status: 'success' })
    const s = agentTraceRepo.statsByRequest('r3')
    expect(s).toEqual({ totalDurationMs: 100, totalTokens: 7, stepCount: 1 })
    expect(s.childRuns, '0 次要说成 undefined，界面才不会写「含 0 次子代理」').toBeUndefined()
  })

  it('兄弟会话不串账：别人的行不因同 request_id 形状而进来', () => {
    agentTraceRepo.insert({ requestId: 'r4', conversationId: 'c4', stepIndex: 0, stepType: 'llm', durationMs: 10, tokenUsage: 5, status: 'success' })
    // 另一棵树的子 run（父 id 不是 r4）
    agentTraceRepo.insert({ requestId: 'rx', conversationId: 'c9', parentRequestId: 'r-other', stepIndex: 0, stepType: 'final', durationMs: 999, tokenUsage: 999, status: 'success' })
    expect(agentTraceRepo.statsByRequest('r4')).toEqual({ totalDurationMs: 10, totalTokens: 5, stepCount: 1 })
  })

  it('直接拿子会话那一次 request 来查也不会变成 0 步（它自己的步就是它的主干）', () => {
    agentTraceRepo.insert({ requestId: 'r5', conversationId: 'c5', stepIndex: 0, stepType: 'llm', durationMs: 100, tokenUsage: 50, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r5c', conversationId: 'c5-child', parentRequestId: 'r5', stepIndex: 0, stepType: 'final', durationMs: 300, tokenUsage: 11, status: 'success' })
    // 子 run 的步带着 parent_request_id，但 request_id 就是 r5c ⇒ 主干条件按 request_id 认，不按"有没有父"认
    expect(agentTraceRepo.statsByRequest('r5c')).toEqual({ totalDurationMs: 300, totalTokens: 11, stepCount: 1 })
  })
})

describe('agentTraceRepo.latestTracesByConversation', () => {
  it('会话无 trace → 空数组', () => {
    expect(agentTraceRepo.latestTracesByConversation('empty')).toEqual([])
  })

  it('返回最近一次运行的全部分步，按 step_index 升序', () => {
    agentTraceRepo.insert({ requestId: 'old', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 1, status: 'success' })
    agentTraceRepo.insert({ requestId: 'new', conversationId: 'c1', stepIndex: 1, stepType: 'tools', toolName: 'time_now,calculator', durationMs: 20, status: 'error', error: 'boom' })
    agentTraceRepo.insert({ requestId: 'new', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 10, tokenUsage: 5, status: 'success' })

    const traces = agentTraceRepo.latestTracesByConversation('c1')
    expect(traces).toHaveLength(2)
    expect(traces.map((x) => x.stepIndex)).toEqual([0, 1])
    expect(traces[0]).toMatchObject({ requestId: 'new', stepType: 'llm', durationMs: 10, tokenUsage: 5, status: 'success' })
    expect(traces[1]).toMatchObject({ requestId: 'new', stepType: 'tools', toolName: 'time_now,calculator', status: 'error', error: 'boom' })
  })

  it('不混入其他会话或旧运行的分步', () => {
    agentTraceRepo.insert({ requestId: 'old', conversationId: 'c1', stepIndex: 0, stepType: 'final', status: 'success' })
    agentTraceRepo.insert({ requestId: 'other', conversationId: 'c2', stepIndex: 0, stepType: 'llm', status: 'success' })
    agentTraceRepo.insert({ requestId: 'new', conversationId: 'c1', stepIndex: 0, stepType: 'degrade', status: 'success' })

    const traces = agentTraceRepo.latestTracesByConversation('c1')
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({ requestId: 'new', stepType: 'degrade' })
  })

  it('输入/输出分开写入后原样读回（分步明细据此显示「输入 X / 输出 Y」）', () => {
    agentTraceRepo.insert({
      requestId: 'r1',
      conversationId: 'c1',
      stepIndex: 0,
      stepType: 'llm',
      durationMs: 10,
      tokenUsage: 5507,
      promptTokens: 5301,
      completionTokens: 206,
      status: 'success'
    })
    expect(agentTraceRepo.latestTracesByConversation('c1')[0]).toMatchObject({
      tokenUsage: 5507,
      promptTokens: 5301,
      completionTokens: 206
    })
  })

  it('未上报 usage 的步（含迁移前的旧行）→ 两个字段是 undefined 而不是 0', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'tools', status: 'success' })
    const tr = agentTraceRepo.latestTracesByConversation('c1')[0]!
    expect(tr.promptTokens).toBeUndefined()
    expect(tr.completionTokens).toBeUndefined()
    // 渲染层的降级分支依赖「合计仍在」这条
    expect(tr.tokenUsage).toBeUndefined()
  })
})

describe('agentTraceRepo.sessionStatsByConversation', () => {
  it('会话无 trace → null', () => {
    expect(agentTraceRepo.sessionStatsByConversation('empty')).toBeNull()
  })

  it('跨多次运行累计：runCount 去重、耗时与 token 求和', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 100, tokenUsage: 10, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 1, stepType: 'tools', durationMs: 50, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r2', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 200, tokenUsage: 30, status: 'success' })

    expect(agentTraceRepo.sessionStatsByConversation('c1')).toEqual({
      runCount: 2,
      totalDurationMs: 350,
      totalTokens: 40
    })
  })

  it('不混入其他会话的 trace', () => {
    agentTraceRepo.insert({ requestId: 'r1', conversationId: 'c1', stepIndex: 0, stepType: 'llm', durationMs: 100, tokenUsage: 10, status: 'success' })
    agentTraceRepo.insert({ requestId: 'r2', conversationId: 'c2', stepIndex: 0, stepType: 'llm', durationMs: 9999, tokenUsage: 999, status: 'success' })

    expect(agentTraceRepo.sessionStatsByConversation('c1')).toEqual({
      runCount: 1,
      totalDurationMs: 100,
      totalTokens: 10
    })
  })
})
