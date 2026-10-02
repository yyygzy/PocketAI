// 提示词片段 repo 测试（导入用 createOrUpdateByTitle 及 findByTitle）
// 策略：mock dbService 记录 SQL 历史，按 SQL 关键词返回预设数据。
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface SqlEntry {
  sql: string
  method: 'all' | 'get' | 'run'
  params: unknown[]
}

const { state } = vi.hoisted(() => ({
  state: {
    sqlLog: [] as SqlEntry[],
    /** SELECT 返回的行（by id） */
    selectRowById: undefined as unknown | undefined,
    /** SELECT 返回的行（by title） */
    selectRowByTitle: undefined as unknown | undefined
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        all: (...params: unknown[]) => {
          state.sqlLog.push({ sql, method: 'all', params })
          return []
        },
        get: (...params: unknown[]) => {
          state.sqlLog.push({ sql, method: 'get', params })
          if (sql.includes('WHERE id=?')) return state.selectRowById
          if (sql.includes('WHERE title=?')) return state.selectRowByTitle
          // 兜底：任何其他 get 调用（如 create() 内的 mustGet）返回一个基本行
          return {
            id: 'mock-id',
            title: 'mock',
            content: 'mock',
            created_at: 1,
            updated_at: 1
          }
        },
        run: (...params: unknown[]) => {
          state.sqlLog.push({ sql, method: 'run', params })
          return { changes: 1 }
        }
      })
    })
  }
}))

import { snippetRepo } from '../src/main/db/repositories/snippet.repo'

beforeEach(() => {
  state.sqlLog = []
  state.selectRowById = undefined
  state.selectRowByTitle = undefined
})

describe('createOrUpdateByTitle — 导入用覆盖/新建', () => {
  it('同名已存在 → UPDATE 内容+updated_at，保留原 id', () => {
    const existing = {
      id: 'old-id',
      title: '翻译助手',
      content: '旧内容',
      created_at: 100,
      updated_at: 200
    }
    state.selectRowByTitle = existing
    state.selectRowById = existing

    const { record, overwritten } = snippetRepo.createOrUpdateByTitle('翻译助手', '新内容')
    expect(overwritten).toBe(true)
    expect(record.title).toBe('翻译助手')
    expect(record.id).toBe('old-id')
    // 断言 UPDATE 已执行
    const updates = state.sqlLog.filter((e) => e.sql.includes('UPDATE'))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.params[0]).toBe('新内容') // content
    expect(updates[0]!.params[2]).toBe('old-id') // id
  })

  it('同名不存在 → INSERT 新 UUID', () => {
    // create() 内部 mustGet(() => this.get(id)) 需要返回刚插入的行
    state.selectRowById = {
      id: 'mock-new-id',
      title: '新片段',
      content: '内容',
      created_at: 1,
      updated_at: 1
    }
    const { record, overwritten } = snippetRepo.createOrUpdateByTitle('新片段', '内容')
    expect(overwritten).toBe(false)
    expect(record.title).toBe('新片段')
    expect(record.content).toBe('内容')
    // mock 下 get 返回固定 id，断言 INSERT 被调用即可
    const inserts = state.sqlLog.filter((e) => e.sql.includes('INSERT INTO'))
    expect(inserts).toHaveLength(1)
  })

  it('findByTitle 命中返回行，未命中返回 null', () => {
    state.selectRowByTitle = {
      id: 's1',
      title: '标题A',
      content: '正文',
      created_at: 1,
      updated_at: 2
    }
    const found = snippetRepo.findByTitle('标题A')
    expect(found).not.toBeNull()
    expect(found!.title).toBe('标题A')

    state.selectRowByTitle = undefined
    expect(snippetRepo.findByTitle('不存在')).toBeNull()
  })
})
