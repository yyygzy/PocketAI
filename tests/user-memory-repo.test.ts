// user-memory.repo 单元测试：行映射 + CRUD + 来源/软删除 + zod 入参校验（二道防线）
//
// 策略：mock dbService（prepare 链）与 mustGet，避免真实数据库初始化；
// 校验 zod 拒绝（空串/超长）、SQL 参数透传（trim/INSERT/UPDATE/DELETE）、changes=0 抛错、
// 软删除只打 deleted_at、活跃行数上限拒绝写入/恢复。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runMock = vi.fn<(sql: string, ...args: unknown[]) => { changes: number }>(() => ({ changes: 1 }))
const getMock = vi.fn<(sql: string, ...args: unknown[]) => unknown>(() => undefined)
const allMock = vi.fn<(sql: string) => unknown[]>(() => [])
const prepareMock = vi.fn<(sql: string) => { run: typeof runMock; get: typeof getMock; all: typeof allMock }>(() => ({
  run: runMock,
  get: getMock,
  all: allMock
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: prepareMock }) }
}))
// mustGet 直通：真实实现为 fn() 为 null 时抛错；此处直接取 fn() 返回值
vi.mock('../src/main/db/must-get', () => ({
  mustGet: (fn: () => unknown, _label: string) => fn()
}))

import { userMemoryRepo, rowToRecord } from '../src/main/db/repositories/user-memory.repo'
import { MEMORY_MAX_ROWS } from '../src/shared/schemas/memory'

const row = {
  id: 'm1',
  content: '用户偏好简洁回复',
  source: 'user' as const,
  conversation_id: null,
  deleted_at: null,
  created_at: 100,
  updated_at: 200
}

describe('rowToRecord — DB 行映射', () => {
  it('字段透传（含来源、会话、软删除时间）', () => {
    const rec = rowToRecord(row)
    expect(rec).toEqual({
      id: 'm1',
      content: '用户偏好简洁回复',
      source: 'user',
      conversationId: null,
      deletedAt: null,
      createdAt: 100,
      updatedAt: 200
    })
  })

  it('Agent 来源与会话 id 透传', () => {
    const rec = rowToRecord({ ...row, source: 'agent', conversation_id: 'conv-1' })
    expect(rec.source).toBe('agent')
    expect(rec.conversationId).toBe('conv-1')
  })

  it('content null → 空串兜底', () => {
    const rec = rowToRecord({ ...row, content: null })
    expect(rec.content).toBe('')
  })
})

describe('userMemoryRepo — CRUD 与校验', () => {
  beforeEach(() => {
    runMock.mockClear()
    getMock.mockClear()
    allMock.mockClear()
    prepareMock.mockClear()
    runMock.mockImplementation(() => ({ changes: 1 }))
    getMock.mockImplementation(() => undefined)
    allMock.mockImplementation(() => [])
  })

  it('list：只查未删除行，SQL 行 → 记录数组', () => {
    allMock.mockImplementation(() => [row])
    const out = userMemoryRepo.list()
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('用户偏好简洁回复')
    expect(prepareMock.mock.calls[0]![0]).toContain('deleted_at IS NULL')
    expect(prepareMock.mock.calls[0]![0]).toContain('ORDER BY updated_at DESC')
  })

  it('listDeleted：只查已软删除行，最近删除的在前', () => {
    allMock.mockImplementation(() => [{ ...row, deleted_at: 300 }])
    const out = userMemoryRepo.listDeleted()
    expect(out).toHaveLength(1)
    expect(out[0]!.deletedAt).toBe(300)
    expect(prepareMock.mock.calls[0]![0]).toContain('deleted_at IS NOT NULL')
    expect(prepareMock.mock.calls[0]![0]).toContain('ORDER BY deleted_at DESC')
  })

  it('add：合法内容写入（trim 后）并返回记录，默认来源 user', () => {
    getMock.mockImplementation((sql) =>
      String(sql).includes('COUNT') ? { n: 0 } : { ...row, id: 'gen-id', content: '你好' }
    )
    const rec = userMemoryRepo.add('  你好  ')
    expect(rec.content).toBe('你好')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('SELECT COUNT(*)')
    const insertSql = String(prepareMock.mock.calls[1]![0])
    expect(insertSql).toContain('INSERT INTO user_memory')
    expect(insertSql).toContain('source')
    expect(insertSql).toContain('conversation_id')
    // INSERT 参数：[id, content, source, conversation_id, created_at, updated_at]
    expect(runMock.mock.calls[0]![1]).toBe('你好')
    expect(runMock.mock.calls[0]![2]).toBe('user')
    expect(runMock.mock.calls[0]![3]).toBeNull()
  })

  it('add：显式来源 agent + 会话 id 落库', () => {
    getMock.mockImplementation((sql) => (String(sql).includes('COUNT') ? { n: 0 } : row))
    userMemoryRepo.add('Agent 记住的偏好', { source: 'agent', conversationId: 'conv-9' })
    expect(runMock.mock.calls[0]![2]).toBe('agent')
    expect(runMock.mock.calls[0]![3]).toBe('conv-9')
  })

  it('add：活跃行数达上限 → 拒绝写入（不删旧数据）', () => {
    getMock.mockImplementation(() => ({ n: MEMORY_MAX_ROWS }))
    expect(() => userMemoryRepo.add('再来一条')).toThrow(`记忆条目已达上限（${MEMORY_MAX_ROWS} 条）`)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('add：空串/纯空白 → ZodError（二道防线）', () => {
    expect(() => userMemoryRepo.add('')).toThrow()
    expect(() => userMemoryRepo.add('   ')).toThrow()
  })

  it('add：超过 2000 字符 → ZodError', () => {
    expect(() => userMemoryRepo.add('x'.repeat(2001))).toThrow()
  })

  it('update：changes=0 → 抛「记忆条目不存在」', () => {
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(() => userMemoryRepo.update('m1', '新内容')).toThrow('记忆条目不存在')
  })

  it('update：命中 → 更新并返回记录（只改未删除行）', () => {
    getMock.mockImplementation(() => ({ ...row, content: '新内容' }))
    const rec = userMemoryRepo.update('m1', '新内容')
    expect(rec.content).toBe('新内容')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('deleted_at IS NULL')
    expect(runMock.mock.calls[0]![0]).toBe('新内容')
  })

  it('update：空内容 → ZodError', () => {
    expect(() => userMemoryRepo.update('m1', '')).toThrow()
  })

  it('remove：软删除，UPDATE deleted_at 并透传 id', () => {
    userMemoryRepo.remove('m1')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('UPDATE user_memory SET deleted_at')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('deleted_at IS NULL')
    expect(runMock.mock.calls[0]![1]).toBe('m1')
  })

  it('restore：清空 deleted_at 并返回记录', () => {
    getMock.mockImplementation((sql) =>
      String(sql).includes('COUNT') ? { n: 0 } : { ...row, deleted_at: null }
    )
    const rec = userMemoryRepo.restore('m1')
    expect(rec.id).toBe('m1')
    expect(String(prepareMock.mock.calls[1]![0])).toContain('SET deleted_at=NULL')
    expect(runMock.mock.calls[0]![0]).toBe('m1')
  })

  it('restore：未删除/不存在 → 抛错', () => {
    getMock.mockImplementation(() => ({ n: 0 }))
    runMock.mockImplementation(() => ({ changes: 0 }))
    expect(() => userMemoryRepo.restore('m1')).toThrow('记忆条目不存在或未被删除')
  })

  it('restore：活跃行数达上限 → 拒绝恢复', () => {
    getMock.mockImplementation(() => ({ n: MEMORY_MAX_ROWS }))
    expect(() => userMemoryRepo.restore('m1')).toThrow(`记忆条目已达上限（${MEMORY_MAX_ROWS} 条）`)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('purge：物理删除只给明确清理动作使用', () => {
    userMemoryRepo.purge('m1')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('DELETE FROM user_memory')
    expect(runMock.mock.calls[0]![0]).toBe('m1')
  })

  it('purgeMany：批量物理删除，参数化 IN 与返回行数', () => {
    runMock.mockImplementation(() => ({ changes: 2 }))
    expect(userMemoryRepo.purgeMany(['m1', 'm2'])).toBe(2)
    expect(String(prepareMock.mock.calls[0]![0])).toContain('DELETE FROM user_memory WHERE id IN (?,?)')
    expect(runMock.mock.calls[0]).toEqual(['m1', 'm2'])
  })

  it('purgeMany：按 500 条分片，不会一次绑上千个参数', () => {
    runMock.mockImplementation((_first: string, ...rest: unknown[]) => ({ changes: rest.length + 1 }))
    const ids = Array.from({ length: 501 }, (_, i) => `m${i}`)
    expect(userMemoryRepo.purgeMany(ids)).toBe(501)
    expect(prepareMock).toHaveBeenCalledTimes(2)
  })

  it('purgeMany：空数组不碰数据库', () => {
    expect(userMemoryRepo.purgeMany([])).toBe(0)
    expect(prepareMock).not.toHaveBeenCalled()
  })

  it('count：只统计未删除行', () => {
    getMock.mockImplementation(() => ({ n: 3 }))
    expect(userMemoryRepo.count()).toBe(3)
    expect(String(prepareMock.mock.calls[0]![0])).toContain('deleted_at IS NULL')
  })
})
