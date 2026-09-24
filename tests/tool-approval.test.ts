// 工具调用审批状态机测试
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApproval, resolveApproval } from '../src/main/agent/tool-approval'
import { IPC } from '../src/shared/types'

const baseReq = {
  requestId: 'req-1',
  conversationId: 'conv-1',
  toolName: 'shell_exec',
  command: 'ls -la',
  reason: 'shell_exec'
}

describe('tool-approval 审批状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('createApproval 广播审批事件并返回 Promise', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)

    expect(emit).toHaveBeenCalledTimes(1)
    const [channel, data] = emit.mock.calls[0]!
    expect(channel).toBe(IPC.AGENT_TOOL_APPROVAL_EVENT)
    expect(data).toMatchObject(baseReq)
    expect(typeof (data as { approvalId: string }).approvalId).toBe('string')

    const approvalId = (data as { approvalId: string }).approvalId
    resolveApproval(approvalId, false)
    await p
  })

  it('resolveApproval(true) 使 Promise resolve(true)', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)
    const approvalId = (emit.mock.calls[0]![1] as { approvalId: string }).approvalId

    resolveApproval(approvalId, true)
    expect(await p).toBe(true)
  })

  it('resolveApproval(false) 使 Promise resolve(false)', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)
    const approvalId = (emit.mock.calls[0]![1] as { approvalId: string }).approvalId

    resolveApproval(approvalId, false)
    expect(await p).toBe(false)
  })

  it('重复应答返回 false，Promise 只 resolve 一次', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)
    const approvalId = (emit.mock.calls[0]![1] as { approvalId: string }).approvalId

    expect(resolveApproval(approvalId, true)).toBe(true)
    expect(resolveApproval(approvalId, false)).toBe(false)
    expect(await p).toBe(true)
  })

  it('未知 approvalId 返回 false', () => {
    expect(resolveApproval('non-existent-id', true)).toBe(false)
  })

  it('超时自动拒绝（5 分钟）', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(await p).toBe(false)
  })

  it('signal abort 时自动拒绝', async () => {
    const emit = vi.fn()
    const controller = new AbortController()
    const p = createApproval(baseReq, emit, controller.signal)

    controller.abort()
    expect(await p).toBe(false)
  })

  it('signal 已 aborted 时直接拒绝，不广播不登记', async () => {
    const emit = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const p = createApproval(baseReq, emit, controller.signal)

    expect(emit).not.toHaveBeenCalled()
    expect(await p).toBe(false)
  })

  it('超时后再应答不生效（幂等）', async () => {
    const emit = vi.fn()
    const p = createApproval(baseReq, emit)
    const approvalId = (emit.mock.calls[0]![1] as { approvalId: string }).approvalId

    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(resolveApproval(approvalId, true)).toBe(false)
    expect(await p).toBe(false)
  })
})
