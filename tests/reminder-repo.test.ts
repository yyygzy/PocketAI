// reminder.repo 单元测试：行映射 + CRUD + 状态流转 + zod 入参校验（二道防线）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runMock = vi.fn<(sql: string, ...args: unknown[]) => { changes: number }>(() => ({ changes: 1 }))
const getMock = vi.fn<(sql: string, ...args: unknown[]) => unknown>(() => undefined)
const allMock = vi.fn<(sql: string, ...args: unknown[]) => unknown[]>(() => [])
const prepareMock = vi.fn<(sql: string) => { run: typeof runMock; get: typeof getMock; all: typeof allMock }>(() => ({
  run: runMock,
  get: getMock,
  all: allMock
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: prepareMock }) }
}))

import { reminderRepo } from '../src/main/db/repositories/reminder.repo'

const row = {
  id: 'r1',
  text: '开会',
  fire_at: 1000,
  status: 'pending',
  conversation_id: 'c1',
  created_at: 500
}

beforeEach(() => {
  runMock.mockClear()
  getMock.mockClear()
  allMock.mockClear()
  prepareMock.mockClear()
  runMock.mockImplementation(() => ({ changes: 1 }))
  getMock.mockImplementation(() => undefined)
  allMock.mockImplementation(() => [])
})

describe('reminderRepo — CRUD 与状态流转', () => {
  it('create：写入 pending 并返回记录（conversationId 可空）', () => {
    getMock.mockImplementation(() => ({ ...row, conversation_id: null }))
    const rec = reminderRepo.create('  开会  ', 1000)
    expect(rec.text).toBe('开会')
    expect(rec.status).toBe('pending')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('INSERT INTO reminders')
    // INSERT 参数：[id, text, fire_at, status, conversation_id, created_at]
    expect(runMock.mock.calls[0]![1]).toBe('开会')
    expect(runMock.mock.calls[0]![2]).toBe(1000)
    expect(runMock.mock.calls[0]![3]).toBe('pending')
    expect(runMock.mock.calls[0]![4]).toBeNull()
  })

  it('create：空文本/超长 → ZodError', () => {
    expect(() => reminderRepo.create('', 1000)).toThrow()
    expect(() => reminderRepo.create('   ', 1000)).toThrow()
    expect(() => reminderRepo.create('x'.repeat(501), 1000)).toThrow()
  })

  it('listDue：按 fire_at 升序查 pending', () => {
    allMock.mockImplementation(() => [row])
    const out = reminderRepo.listDue(2000)
    expect(out).toHaveLength(1)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('fire_at<=')
    expect(sql).toContain('ORDER BY fire_at ASC')
    expect(allMock.mock.calls[0]![0]).toBe('pending')
    expect(allMock.mock.calls[0]![1]).toBe(2000)
  })

  it('listByStatus：非法 status → ZodError', () => {
    expect(() => reminderRepo.listByStatus('bogus' as never)).toThrow()
  })

  it('markFired / markMissed：状态翻转', () => {
    reminderRepo.markFired('r1')
    expect(runMock.mock.calls[0]![0]).toBe('fired')
    reminderRepo.markMissed('r2')
    expect(runMock.mock.calls[1]![0]).toBe('missed')
  })

  it('cancel：仅 pending 可取消，changes=0 → false', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.cancel('r1')).toBe(false)
    expect(String(prepareMock.mock.calls[0]![0])).toContain("status='pending'")
    runMock.mockImplementation(() => ({ changes: 1 }))
    expect(reminderRepo.cancel('r1')).toBe(true)
  })

  it('countPending：返回条数', () => {
    getMock.mockImplementation(() => ({ n: 7 }))
    expect(reminderRepo.countPending()).toBe(7)
  })

  it('行映射：status 非法值兜底 pending，conversation_id null → null', () => {
    getMock.mockImplementation(() => ({ ...row, status: null, conversation_id: null }))
    const rec = reminderRepo.get('r1')
    expect(rec?.status).toBe('pending')
    expect(rec?.conversationId).toBeNull()
  })
})
