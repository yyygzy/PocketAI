// 工具审批「本次会话总是允许」白名单测试
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createApproval,
  resolveApproval,
  clearSessionAllow,
  resetApprovalStateForTest
} from '../src/main/agent/tool-approval'

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'r-1',
    conversationId: 'c-1',
    toolName: 'shell_exec',
    command: 'echo hi',
    cwd: '/tmp',
    reason: 'REQUIRES_CONFIRM',
    risk: 'danger' as const,
    ...overrides
  }
}

describe('tool-approval session allowlist', () => {
  beforeEach(() => {
    resetApprovalStateForTest()
  })

  it('首次审批无白名单：广播事件并等待应答', async () => {
    const emit = vi.fn()
    const p = createApproval(makeReq(), emit)
    expect(emit).toHaveBeenCalledTimes(1)
    // 取 approvalId 并 resolve
    const event = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(event.approvalId, true, true)
    await expect(p).resolves.toBe(true)
  })

  it('勾选 alwaysAllow 后，同会话同工具直接放行且不广播', async () => {
    const emit = vi.fn()
    const p1 = createApproval(makeReq(), emit)
    const event = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(event.approvalId, true, true)
    await expect(p1).resolves.toBe(true)

    emit.mockClear()
    const p2 = createApproval(makeReq(), emit)
    expect(emit).not.toHaveBeenCalled()
    await expect(p2).resolves.toBe(true)
  })

  it('拒绝不写入白名单：下次仍需弹窗', async () => {
    const emit = vi.fn()
    const p1 = createApproval(makeReq(), emit)
    const event = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(event.approvalId, false, true) // 拒绝但勾了 alwaysAllow
    await expect(p1).resolves.toBe(false)

    emit.mockClear()
    createApproval(makeReq(), emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('白名单按会话隔离：不同会话仍弹窗', async () => {
    const emit = vi.fn()
    const p1 = createApproval(makeReq({ conversationId: 'c-1' }), emit)
    const e1 = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(e1.approvalId, true, true)
    await expect(p1).resolves.toBe(true)

    emit.mockClear()
    createApproval(makeReq({ conversationId: 'c-2' }), emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('白名单按工具名隔离：不同工具仍弹窗', async () => {
    const emit = vi.fn()
    const p1 = createApproval(makeReq({ toolName: 'shell_exec' }), emit)
    const e1 = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(e1.approvalId, true, true)
    await expect(p1).resolves.toBe(true)

    emit.mockClear()
    createApproval(makeReq({ toolName: 'file_write' }), emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('clearSessionAllow 后需重新弹窗', async () => {
    const emit = vi.fn()
    const p1 = createApproval(makeReq(), emit)
    const e1 = emit.mock.calls[0]![1] as { approvalId: string }
    resolveApproval(e1.approvalId, true, true)
    await expect(p1).resolves.toBe(true)

    clearSessionAllow('c-1')
    emit.mockClear()
    createApproval(makeReq(), emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('单会话超过 50 个工具名时 FIFO 淘汰最旧', async () => {
    const emit = vi.fn()
    // 前 50 个工具都标 alwaysAllow
    for (let i = 0; i < 50; i++) {
      const p = createApproval(makeReq({ toolName: `tool-${i}` }), emit)
      const ev = emit.mock.calls.at(-1)![1] as { approvalId: string }
      resolveApproval(ev.approvalId, true, true)
      await expect(p).resolves.toBe(true)
    }
    // tool-0 应仍在白名单
    emit.mockClear()
    await expect(createApproval(makeReq({ toolName: 'tool-0' }), emit)).resolves.toBe(true)
    expect(emit).not.toHaveBeenCalled()

    // 加入第 51 个，淘汰 tool-0
    const pNew = createApproval(makeReq({ toolName: 'tool-50' }), emit)
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls.at(-1)![1] as { approvalId: string }
    resolveApproval(ev.approvalId, true, true)
    await expect(pNew).resolves.toBe(true)

    // tool-0 被淘汰，需重新弹窗
    emit.mockClear()
    createApproval(makeReq({ toolName: 'tool-0' }), emit)
    expect(emit).toHaveBeenCalledTimes(1)
  })
})
