// 审批五档分档 + settle 幂等（P0-2c-1）
//
// 只测 createApproval 的“决定 → 审计事件”映射；落库本身在 approval-events-real-db.test.ts。
// 关键点：超时/中止/用户应答都走同一个 settle，若映射写错或 cleanup 顺序写反，
// 会出现「用户拒绝被记成超时」或「同一次审批写两条」——后者尤其不能用"看日志"来验收。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ApprovalAuditContext, ApprovalAuditWriteInput } from '../src/shared/types'
import {
  APPROVAL_TIMEOUT_MS,
  createApproval,
  resolveApproval,
  resetApprovalStateForTest,
  toolArgsFingerprint
} from '../src/main/agent/tool-approval'

const calls: ApprovalAuditWriteInput[] = []

const audit: ApprovalAuditContext = {
  assistantId: 'asst-1',
  stepIndex: 4,
  toolCallId: 'call-1',
  toolId: 'shell.exec',
  requestedAt: 1000,
  record: (input) => {
    calls.push(input)
  }
}

const req = {
  requestId: 'req-1',
  conversationId: 'c-1',
  toolName: 'shell.exec',
  command: 'ls -la',
  cwd: '/tmp',
  reason: 'REQUIRES_CONFIRM'
}

const ARGS = '{"command":"ls -la"}'

function start(signal?: AbortSignal, withAudit = true): {
  promise: Promise<boolean>
  emitted: Array<{ channel: string; data: { approvalId: string } }>
} {
  const emitted: Array<{ channel: string; data: { approvalId: string } }> = []
  const promise = createApproval(
    req,
    (channel, data) => emitted.push({ channel, data: data as { approvalId: string } }),
    signal,
    ARGS,
    withAudit ? audit : undefined
  )
  return { promise, emitted }
}

beforeEach(() => {
  calls.length = 0
  resetApprovalStateForTest()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('五档分档', () => {
  it('用户批准 → user_approve / once', async () => {
    const { promise, emitted } = start()
    resolveApproval(emitted[0]!.data.approvalId, true)
    expect(await promise).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      requestId: 'req-1',
      conversationId: 'c-1',
      toolName: 'shell.exec',
      decision: 'user_approve',
      reasonCode: 'USER_APPROVE',
      scope: 'once',
      argsDigest: toolArgsFingerprint(ARGS)
    })
  })

  it('用户拒绝 → user_deny / once', async () => {
    const { promise, emitted } = start()
    resolveApproval(emitted[0]!.data.approvalId, false)
    expect(await promise).toBe(false)
    expect(calls[0]).toMatchObject({ decision: 'user_deny', reasonCode: 'USER_DENY', scope: 'once' })
  })

  it('批准并勾选会话总是允许 → user_approve / session，后续同类调用 auto_allow / session', async () => {
    const first = start()
    resolveApproval(first.emitted[0]!.data.approvalId, true, true)
    expect(await first.promise).toBe(true)
    expect(calls[0]).toMatchObject({ decision: 'user_approve', scope: 'session' })

    const second = start()
    expect(await second.promise).toBe(true)
    expect(second.emitted).toHaveLength(0) // 命中会话白名单，不再弹窗
    expect(calls[1]).toMatchObject({ decision: 'auto_allow', reasonCode: 'SESSION_ALLOW', scope: 'session' })
  })

  it('超时 → timeout_deny / once', async () => {
    const { promise, emitted } = start()
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)
    expect(await promise).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ decision: 'timeout_deny', reasonCode: 'TIMEOUT', scope: 'once' })
    // 超时收尾后再来一个"用户批准"不能补写第二条
    expect(resolveApproval(emitted[0]!.data.approvalId, true)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('中止 → policy_deny / ABORTED，且定时器不再补写', async () => {
    const ac = new AbortController()
    const { promise } = start(ac.signal)
    ac.abort()
    expect(await promise).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ decision: 'policy_deny', reasonCode: 'ABORTED', scope: 'once' })

    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)
    expect(calls, '中止已 settle，定时器必须被清掉，不许再写一条超时').toHaveLength(1)
  })

  it('发起前已中止 → 不广播弹窗，但记一条 policy_deny / ABORTED', async () => {
    const ac = new AbortController()
    ac.abort()
    const { promise, emitted } = start(ac.signal)
    expect(await promise).toBe(false)
    expect(emitted).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ decision: 'policy_deny', reasonCode: 'ABORTED' })
  })

  it('无审计上下文（旧调用点）→ 不写任何审计事件，行为不变', async () => {
    const { promise, emitted } = start(undefined, false)
    resolveApproval(emitted[0]!.data.approvalId, true)
    expect(await promise).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
