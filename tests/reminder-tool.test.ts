// reminder 内置工具单元测试：参数校验与错误分支（mock repo，不落库）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createMock, countPendingMock, listByStatusMock, cancelMock } = vi.hoisted(() => ({
  createMock: vi.fn<(text: string, fireAt: number, convId?: string | null) => unknown>((text, fireAt) => ({
    id: 'r-new',
    text,
    fireAt,
    status: 'pending',
    conversationId: null,
    createdAt: 1
  })),
  countPendingMock: vi.fn<() => number>(() => 0),
  listByStatusMock: vi.fn<(status: string, limit: number) => unknown[]>(() => []),
  cancelMock: vi.fn<() => boolean>(() => true)
}))

vi.mock('../src/main/db/repositories/reminder.repo', () => ({
  reminderRepo: {
    create: createMock,
    countPending: countPendingMock,
    listByStatus: listByStatusMock,
    cancel: cancelMock
  }
}))

import { reminderSetTool, reminderListTool, reminderCancelTool } from '../src/main/tools/reminder'

beforeEach(() => {
  createMock.mockClear()
  countPendingMock.mockClear()
  listByStatusMock.mockClear()
  cancelMock.mockClear()
  createMock.mockImplementation((text, fireAt) => ({
    id: 'r-new',
    text,
    fireAt,
    status: 'pending',
    conversationId: null,
    createdAt: 1
  }))
  countPendingMock.mockImplementation(() => 0)
  cancelMock.mockImplementation(() => true)
})

describe('reminder_set — 参数校验', () => {
  it('in_minutes 相对时间：fireAt = now + N 分钟', async () => {
    const before = Date.now()
    const out = JSON.parse(await reminderSetTool.execute({ text: '喝水', in_minutes: 30 }))
    expect(out.ok).toBe(true)
    expect(out.fireAt).toBeGreaterThanOrEqual(before + 30 * 60_000)
    expect(out.fireAtLocal).toContain(':')
    expect(createMock.mock.calls[0]![0]).toBe('喝水')
  })

  it('at 绝对时间（ISO）：原样解析', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    const out = JSON.parse(await reminderSetTool.execute({ text: '开会', at: future }))
    expect(out.ok).toBe(true)
    expect(out.fireAt).toBe(Date.parse(future))
  })

  it('in_minutes 与 at 同时给/都不给 → 报错', async () => {
    await expect(
      reminderSetTool.execute({ text: 'x', in_minutes: 5, at: new Date(Date.now() + 60000).toISOString() })
    ).rejects.toThrow('必须且只能提供一个')
    await expect(reminderSetTool.execute({ text: 'x' })).rejects.toThrow('必须且只能提供一个')
  })

  it('in_minutes 越界（0 / 43201）→ 报错', async () => {
    await expect(reminderSetTool.execute({ text: 'x', in_minutes: 0 })).rejects.toThrow('1-43200')
    await expect(reminderSetTool.execute({ text: 'x', in_minutes: 43201 })).rejects.toThrow('1-43200')
  })

  it('at 非法字符串 / 过去时间 → 报错', async () => {
    await expect(reminderSetTool.execute({ text: 'x', at: 'not-a-date' })).rejects.toThrow('ISO 8601')
    await expect(reminderSetTool.execute({ text: 'x', at: '2000-01-01T00:00:00Z' })).rejects.toThrow('晚于当前时间')
  })

  it('text 为空 → 报错', async () => {
    await expect(reminderSetTool.execute({ text: '  ', in_minutes: 5 })).rejects.toThrow('text 不能为空')
  })

  it('pending 达上限 50 → 拒绝', async () => {
    countPendingMock.mockImplementation(() => 50)
    await expect(reminderSetTool.execute({ text: 'x', in_minutes: 5 })).rejects.toThrow('上限')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('透传 conversationId（ctx.agent）', async () => {
    await reminderSetTool.execute({ text: 'x', in_minutes: 5 }, { agent: { requestId: 'q1', conversationId: 'c9', emit: () => {} } })
    expect(createMock.mock.calls[0]![2]).toBe('c9')
  })
})

describe('reminder_list — 查询', () => {
  it('默认 pending + limit 20', async () => {
    const out = JSON.parse(await reminderListTool.execute({}))
    expect(out.count).toBe(0)
    expect(listByStatusMock.mock.calls[0]![0]).toBe('pending')
  })

  it('非法 status → 报错', async () => {
    await expect(reminderListTool.execute({ status: 'bogus' })).rejects.toThrow('status 必须是')
  })

  it('limit 钳制到 1-50', async () => {
    await reminderListTool.execute({ limit: 999 })
    expect(listByStatusMock.mock.calls[0]![1]).toBe(50)
  })

  it('返回条目含本地格式化时间', async () => {
    listByStatusMock.mockImplementation(() => [
      { id: 'r1', text: '开会', fireAt: 1735689600000, status: 'pending', conversationId: null, createdAt: 0 }
    ])
    const out = JSON.parse(await reminderListTool.execute({}))
    expect(out.reminders[0].fireAtLocal).toContain(':')
  })
})

describe('reminder_cancel — 取消', () => {
  it('成功返回剩余数', async () => {
    countPendingMock.mockImplementation(() => 2)
    const out = JSON.parse(await reminderCancelTool.execute({ id: 'r1' }))
    expect(out.ok).toBe(true)
    expect(out.remaining).toBe(2)
  })

  it('id 为空 / 取消失败 → 报错', async () => {
    await expect(reminderCancelTool.execute({ id: '  ' })).rejects.toThrow('id 不能为空')
    cancelMock.mockImplementation(() => false)
    await expect(reminderCancelTool.execute({ id: 'r1' })).rejects.toThrow('取消失败')
  })
})
