// @vitest-environment jsdom
// P2 / V4-Iter-459：轮次检查器本体（按需展开、步骤流 / 每步 token / 变更清单 / 子会话入口）
//
// 关键不变量：
// · 摘要常驻时**不读库**；展开后才调 getRunTraces（「按需展开」不是一句文案）；
// · 变更清单来自 trace 的 change_set，经 `shared/workspace-changes.ts` 解析后渲染；
// · 轮次里的子 run 能进对应子会话（按钮把 conversationId 交给回调）。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AgentRunSummary } from '../src/renderer/src/modules/agent/components/AgentRunSummary'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import type { AgentRunIndexEntry, AgentTraceRecord } from '../src/shared/types'

const RUN: AgentRunIndexEntry = {
  requestId: 'req-459',
  conversationId: 'conv-459',
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_040_000,
  stepCount: 3,
  totalDurationMs: 40_000,
  totalTokens: 1_250,
  errorSteps: 0,
  messageIds: [],
  changeCount: 3,
  childRuns: 1,
  childConversationIds: ['child-459']
}

const TRACES: AgentTraceRecord[] = [
  {
    id: 'tr-1',
    requestId: 'req-459',
    conversationId: 'conv-459',
    stepIndex: 1,
    stepType: 'tools',
    toolName: 'fs_write',
    durationMs: 12_000,
    tokenUsage: 300,
    promptTokens: 200,
    completionTokens: 100,
    status: 'success',
    toolArgs: '{"path":"src/a.ts"}',
    toolResult: 'ok',
    changeSet: JSON.stringify({
      status: 'ok',
      entries: [{ path: 'src/a.ts', size: 128, kind: 'modified', content: 'hashed' }],
      counts: { added: 0, modified: 1, deleted: 0 },
      scanMs: 20
    }),
    createdAt: 1_760_000_000_000
  }
]

describe('P2 轮次检查器', () => {
  it('摘要折叠不读库；展开后读 trace、渲染变更清单与子会话入口', async () => {
    stubPocketai({
      getRunTraces: (requestId: string) => {
        expect(requestId).toBe('req-459')
        return TRACES
      }
    })
    const onOpenSubSession = vi.fn()
    mountWithProviders(<AgentRunSummary run={RUN} onOpenSubSession={onOpenSubSession} />)

    // 摘要常驻：数字已经在屏上，但还没碰库
    expect(screen.getByTestId('agent-run-summary')).toBeTruthy()
    expect(calledFns()).not.toContain('getRunTraces')
    expect(screen.queryByTestId('agent-run-inspector')).toBeNull()

    fireEvent.click(screen.getByTestId('agent-run-summary-toggle'))
    await waitFor(() => expect(calledFns()).toContain('getRunTraces'))
    await waitFor(() => expect(screen.getByTestId('agent-run-inspector')).toBeTruthy())

    // 步骤行：工具名 + 每步 token（200 输入 + 100 输出）
    const stepButton = await screen.findByTestId('trace-io-tr-1')
    expect(stepButton.textContent).toContain('fs_write')
    expect(stepButton.textContent).toContain('200')
    expect(stepButton.textContent).toContain('100')

    // 变更清单按需展开：数据来自 change_set，路径与计数都要出现
    fireEvent.click(stepButton)
    const changes = await screen.findByTestId('trace-changes')
    expect(changes.textContent).toContain('src/a.ts')
    expect(changes.textContent).toContain('1')

    // 子会话入口：从这一轮的子 run 进对应子会话
    fireEvent.click(screen.getByTestId('agent-run-open-sub-child-459'))
    expect(onOpenSubSession).toHaveBeenCalledWith('child-459')
  })
})
