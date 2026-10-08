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

  it('listHistory：只查 fired/missed/cancelled 三态，按 fire_at 倒序，默认 50 条', () => {
    allMock.mockImplementation(() => [{ ...row, status: 'fired' }])
    const out = reminderRepo.listHistory()
    expect(out).toHaveLength(1)
    expect(out[0]!.status).toBe('fired')
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain("status IN ('fired','missed','cancelled')")
    expect(sql).toContain('ORDER BY fire_at DESC')
    expect(allMock.mock.calls[0]![0]).toBe(50)
  })

  it('listHistory：自定义 limit 透传', () => {
    reminderRepo.listHistory(100)
    expect(allMock.mock.calls[0]![0]).toBe(100)
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

describe('reminderRepo.update — 编辑 pending', () => {
  it('空 fields → false，不查 DB', () => {
    expect(reminderRepo.update('r1', {})).toBe(false)
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('仅改 text：SET text=?, WHERE status=pending，返回 true', () => {
    expect(reminderRepo.update('r1', { text: '新内容' })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('SET text=?')
    expect(sql).toContain("status='pending'")
    expect(runMock.mock.calls[0]![0]).toBe('新内容')
    expect(runMock.mock.calls[0]![1]).toBe('r1')
  })

  it('仅改 fireAt：SET fire_at=?', () => {
    expect(reminderRepo.update('r1', { fireAt: 9999 })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('fire_at=?')
    expect(runMock.mock.calls[0]![0]).toBe(9999)
  })

  it('repeatRule=null：清除循环变一次性，SET repeat_rule=NULL', () => {
    expect(reminderRepo.update('r1', { repeatRule: null })).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('repeat_rule=?')
    expect(runMock.mock.calls[0]![0]).toBeNull()
  })

  it('repeatRule=daily：写入 JSON 字符串', () => {
    expect(reminderRepo.update('r1', { repeatRule: { kind: 'daily', intervalDays: 3 } })).toBe(true)
    expect(runMock.mock.calls[0]![0]).toBe('{"kind":"daily","intervalDays":3}')
  })

  it('三字段合改：SET 三个字段', () => {
    expect(
      reminderRepo.update('r1', {
        text: '合改',
        fireAt: 12345,
        repeatRule: { kind: 'weekly', weekdays: [1, 3] }
      })
    ).toBe(true)
    const sql = String(prepareMock.mock.calls[0]![0])
    expect(sql).toContain('text=?')
    expect(sql).toContain('fire_at=?')
    expect(sql).toContain('repeat_rule=?')
    expect(runMock.mock.calls[0]![0]).toBe('合改')
    expect(runMock.mock.calls[0]![1]).toBe(12345)
    expect(runMock.mock.calls[0]![2]).toBe('{"kind":"weekly","weekdays":[1,3]}')
    expect(runMock.mock.calls[0]![3]).toBe('r1')
  })

  it('changes=0（非 pending 行）→ false', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.update('r1', { text: 'x' })).toBe(false)
  })
})

describe('reminderRepo.rescheduleNext — 一键重新安排 missed 循环', () => {
  it('记录不存在 → { ok: false }', () => {
    getMock.mockImplementation(() => undefined)
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })

  it('一次性提醒（无 repeatRule）→ { ok: false }', () => {
    getMock.mockImplementation(() => ({ ...row, repeat_rule: null, status: 'missed' }))
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })

  it('daily 循环：按 computeNextFireAt 重算 next（prevFireAt + intervalDays 天）', () => {
    getMock.mockImplementation(() => ({
      ...row,
      fire_at: 1000,
      status: 'missed',
      repeat_rule: '{"kind":"daily","intervalDays":1}'
    }))
    const out = reminderRepo.rescheduleNext('r1')
    expect(out.ok).toBe(true)
    // 1000 + 1*86400000 = 86401000
    expect(out.fireAt).toBe(86401000)
    // reschedule 走 run：参数 (status='pending', fireAt, ruleJson, id)
    expect(runMock.mock.calls[0]![0]).toBe('pending')
    expect(runMock.mock.calls[0]![1]).toBe(86401000)
    expect(runMock.mock.calls[0]![2]).toBe('{"kind":"daily","intervalDays":1}')
    expect(runMock.mock.calls[0]![3]).toBe('r1')
  })

  it('reschedule 返回 false（changes=0）→ { ok: false }', () => {
    getMock.mockImplementation(() => ({
      ...row,
      repeat_rule: '{"kind":"daily","intervalDays":1}'
    }))
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(reminderRepo.rescheduleNext('r1')).toEqual({ ok: false })
  })
})
