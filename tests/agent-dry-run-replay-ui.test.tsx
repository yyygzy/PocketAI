// @vitest-environment jsdom
// P0-5 dry-run 回放 UI 入口：轮次检查器按 requestId 只读重建账本，并把三组全等判据上屏。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { AgentRunInspector } from '../src/renderer/src/components/agent/AgentRunInspector'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import type { AgentRunIndexEntry, AgentTraceRecord } from '../src/shared/types'

const RUN: AgentRunIndexEntry = {
  requestId: 'req-dry',
  conversationId: 'conv-dry',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_030_000,
  stepCount: 2,
  totalDurationMs: 30_000,
  totalTokens: 900,
  errorSteps: 0,
  messageIds: []
}

const TRACES: AgentTraceRecord[] = [
  {
    id: 'tr-dry-1',
    requestId: 'req-dry',
    conversationId: 'conv-dry',
    stepIndex: 1,
    stepType: 'tools',
    toolName: 'fs_read',
    durationMs: 1_000,
    tokenUsage: 100,
    promptTokens: 60,
    completionTokens: 40,
    status: 'success',
    createdAt: 1_760_000_000_000
  },
  {
    id: 'tr-dry-2',
    requestId: 'req-dry',
    conversationId: 'conv-dry',
    stepIndex: 2,
    stepType: 'llm',
    durationMs: 2_000,
    tokenUsage: 200,
    promptTokens: 120,
    completionTokens: 80,
    status: 'success',
    createdAt: 1_760_000_001_000
  }
]

const RESULT = {
  report: { requestId: 'req-dry', steps: TRACES.map((t) => ({ stepIndex: t.stepIndex, status: t.status })), toolAttemptsBlocked: 0, mcpConnectsBlocked: 0 },
  safety: { fileTreeEqual: true, outboundEqual: true, mcpToolCallsEqual: true, tableDiffs: [] }
}

describe('轮次检查器 dry-run 回放入口', () => {
  it('点按钮按本次 requestId 回放，并把全等判据上屏', async () => {
    const replay = vi.fn(() => RESULT)
    stubPocketai({ getRunTraces: () => TRACES, replayTraceDryRun: replay })
    mountWithProviders(<AgentRunInspector run={RUN} />)
    await act(async () => {})

    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-run-dry-replay'))
    })

    expect(replay).toHaveBeenCalledWith('req-dry')
    const box = screen.getByTestId('agent-run-dry-replay-result')
    expect(box.textContent).toContain('回放 2 步')
    expect(box.textContent).toContain('文件树一致')
    expect(box.textContent).toContain('出网一致')
    expect(box.textContent).toContain('表行数一致')
  })

  it('回放读失败时显示失败事实，不冒充空报告', async () => {
    stubPocketai({
      getRunTraces: () => TRACES,
      replayTraceDryRun: () => ({ ok: false, error: '账本读不到' })
    })
    mountWithProviders(<AgentRunInspector run={RUN} />)
    await act(async () => {})

    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-run-dry-replay'))
    })

    expect(screen.getByTestId('agent-run-dry-replay-error').textContent).toContain('账本读不到')
    expect(screen.queryByTestId('agent-run-dry-replay-result')).toBeNull()
  })
})
