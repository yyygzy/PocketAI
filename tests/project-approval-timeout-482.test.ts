// 审批超时（四种零残留之一）：5 分钟无应答按拒绝收敛，且之后不再接受该审批的放行。
//
// 为什么单独一条：引擎里 execute 只在 `await createApproval(...) === true` 之后发生，
// 超时零残留的结构性保证就落在"返回 false"这一句上；真跑 5 分钟不现实，这里用假时钟钉住它。
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  APPROVAL_TIMEOUT_MS,
  createApproval,
  resolveApproval,
  resetApprovalStateForTest
} from '../src/main/agent/tool-approval'
import type { ToolApprovalRequestEvent } from '../src/shared/types'

afterEach(() => {
  resetApprovalStateForTest()
  vi.useRealTimers()
})

describe('审批超时', () => {
  it('5 分钟无应答 ⇒ createApproval 返回 false，且过期后放行无效', async () => {
    vi.useFakeTimers()
    const events: ToolApprovalRequestEvent[] = []
    const decisions: Array<{ decision: string; reasonCode: string }> = []

    const promise = createApproval(
      {
        requestId: 'req-timeout',
        conversationId: 'conv-timeout',
        toolName: 'project_create',
        command: 'demo → /ws/apps/demo',
        reason: 'PROJECT_WRITE_WORKSPACE',
        risk: 'custom',
        forceConfirm: true,
        fields: [{ key: 'project_name', value: 'demo' }]
      },
      (_channel, data) => {
        events.push(data as ToolApprovalRequestEvent)
      },
      undefined,
      JSON.stringify({ name: 'demo', target: 'apps', files: [] }),
      {
        requestedAt: Date.now(),
        record: (input) => decisions.push({ decision: input.decision, reasonCode: input.reasonCode })
      }
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.forceConfirm).toBe(true)

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS + 1)
    await expect(promise).resolves.toBe(false)
    expect(decisions).toEqual([{ decision: 'timeout_deny', reasonCode: 'TIMEOUT' }])

    // 超时后再点「允许」必须无效（pending 已删除），不会补写
    expect(resolveApproval(events[0]!.approvalId, true)).toBe(false)
  })
})
