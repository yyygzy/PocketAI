// @vitest-environment node
// P0-5 dry-run 回放：按账本重建（不调模型、不调工具）
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/repositories/agent-trace.repo', () => ({ agentTraceRepo: {} }))
vi.mock('../src/main/db/repositories/message.repo', () => ({ messageRepo: {} }))
vi.mock('../src/main/portable', () => ({ DATA_DIR: '/tmp/pocketai-dry-run', DB_PATH: '/tmp/pocketai-dry-run/app.db' }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import type { AgentTraceRecord } from '../src/shared/types'
import { replayTraceDryRun } from '../src/main/agent/dry-run-replay'

function trace(over: Partial<AgentTraceRecord>): AgentTraceRecord {
  return {
    id: 't',
    requestId: 'r1',
    conversationId: 'c1',
    stepIndex: 0,
    stepType: 'tools',
    status: 'success',
    createdAt: 1,
    ...over
  }
}

describe('replayTraceDryRun — 只读账本重建', () => {
  it('有 messageId 时读 messages 原文并按调用拆开（优先级高于 trace 副本）', async () => {
    const read = vi.fn((id: string) =>
      id === 'm1'
        ? JSON.stringify({ toolCallId: 'tc1', name: 'fs_read', content: '全文', isError: false })
        : null
    )
    const report = await replayTraceDryRun('r1', {
      listSteps: () => [
        trace({ stepIndex: 1, stepType: 'tools', toolName: 'fs_read', messageId: 'm1', toolResult: '被截断的副本' })
      ],
      readMessageContent: read
    })

    const step = report.steps[0]!
    expect(step.output?.source).toBe('messages')
    expect(step.output?.calls).toEqual([
      { toolCallId: 'tc1', name: 'fs_read', isError: false, content: '全文' }
    ])
    expect(step.missing).toBeUndefined()
    expect(report.toolAttemptsBlocked).toBe(0)
  })

  it('没有引用列时退回 trace 的诊断副本，并标成 trace 来源', async () => {
    const report = await replayTraceDryRun('r1', {
      listSteps: () => [trace({ toolResult: 'fs_read OK 短结果' })],
      readMessageContent: () => null
    })
    expect(report.steps[0]?.output).toEqual({ source: 'trace', text: 'fs_read OK 短结果' })
    expect(report.steps[0]?.missing).toBeUndefined()
  })

  it('有引用但消息行不在 ⇒ expired，且不拿截断副本冒充原文', async () => {
    const report = await replayTraceDryRun('r1', {
      listSteps: () => [trace({ messageId: 'm1', coldRef: '@outputs/m1.txt', toolResult: '被截断的副本' })],
      readMessageContent: () => null
    })
    expect(report.steps[0]?.missing).toBe('expired')
    expect(report.steps[0]?.output).toEqual({ source: 'messages', calls: [] })
  })

  it('没有任何副本 ⇒ never_stored（与 expired 分开说）', async () => {
    const report = await replayTraceDryRun('r1', {
      listSteps: () => [trace({})],
      readMessageContent: () => null
    })
    expect(report.steps[0]?.missing).toBe('never_stored')
    expect(report.steps[0]?.output).toBeUndefined()
  })

  it('非 tools 步原样保留，不造工具输出', async () => {
    const report = await replayTraceDryRun('r1', {
      listSteps: () => [
        trace({ stepIndex: 1, stepType: 'llm', status: 'error', error: 'empty_response' }),
        trace({ stepIndex: 2, stepType: 'final' })
      ],
      readMessageContent: () => null
    })
    expect(report.steps.map((s) => s.stepType)).toEqual(['llm', 'final'])
    expect(report.steps[0]?.error).toBe('empty_response')
    expect(report.steps.every((s) => s.output === undefined)).toBe(true)
    expect(report.conversationId).toBe('c1')
  })

  it('trace 读不出来 ⇒ unavailable，不硬凑成空运行', async () => {
    const report = await replayTraceDryRun('r1', {
      listSteps: () => {
        throw new Error('no such table: agent_traces')
      },
      readMessageContent: () => null
    })
    expect(report.unavailable).toBe(true)
    expect(report.error).toContain('no such table')
    expect(report.steps).toEqual([])
  })
})
