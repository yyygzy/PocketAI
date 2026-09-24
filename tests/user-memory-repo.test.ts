// user-memory.repo 单元测试：行映射 + CRUD + zod 入参校验（二道防线）
//
// 策略：mock dbService（prepare 链）与 mustGet，避免真实数据库初始化；
// 校验 zod 拒绝（空串/超长）、SQL 参数透传（trim/INSERT/UPDATE/DELETE）、changes=0 抛错。
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

const row = {
  id: 'm1',
  content: '用户偏好简洁回复',
  created_at: 100,
  updated_at: 200
}

describe('rowToRecord — DB 行映射', () => {
  it('字段透传', () => {
    const rec = rowToRecord(row)
    expect(rec).toEqual({ id: 'm1', content: '用户偏好简洁回复', createdAt: 100, updatedAt: 200 })
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

  it('list：SQL 行 → 记录数组', () => {
    allMock.mockImplementation(() => [row])
    const out = userMemoryRepo.list()
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toBe('用户偏好简洁回复')
    expect(prepareMock.mock.calls[0]![0]).toContain('ORDER BY updated_at DESC')
  })

  it('add：合法内容写入（trim 后）并返回记录', () => {
    getMock.mockImplementation(() => ({ ...row, id: 'gen-id', content: '你好' }))
    const rec = userMemoryRepo.add('  你好  ')
    expect(rec.content).toBe('你好')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('INSERT INTO user_memory')
    // INSERT 参数：[id, content, created_at, updated_at]
    expect(runMock.mock.calls[0]![1]).toBe('你好')
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

  it('update：命中 → 更新并返回记录', () => {
    getMock.mockImplementation(() => ({ ...row, content: '新内容' }))
    const rec = userMemoryRepo.update('m1', '新内容')
    expect(rec.content).toBe('新内容')
    expect(runMock.mock.calls[0]![0]).toBe('新内容')
  })

  it('update：空内容 → ZodError', () => {
    expect(() => userMemoryRepo.update('m1', '')).toThrow()
  })

  it('remove：DELETE 语句透传 id', () => {
    userMemoryRepo.remove('m1')
    expect(String(prepareMock.mock.calls[0]![0])).toContain('DELETE FROM user_memory')
    expect(runMock.mock.calls[0]![0]).toBe('m1')
  })

  it('count：返回行数', () => {
    getMock.mockImplementation(() => ({ n: 3 }))
    expect(userMemoryRepo.count()).toBe(3)
  })
})
