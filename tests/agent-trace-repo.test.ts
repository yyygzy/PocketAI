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
    step_index INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    tool_name TEXT,
    duration_ms INTEGER,
    token_usage INTEGER,
    status TEXT,
    error TEXT,
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
