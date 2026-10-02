// kb-ask-session.repo 搜索测试
//
// 覆盖 src/main/db/repositories/kb-ask-session.repo.ts 的 searchByKb：
// LIKE 匹配标题/消息体，空关键词回退全量列表；返回行映射为 KbAskSessionMeta。
//
// 策略：mock dbService 的 prepare().all() 链，捕获 SQL 与参数。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    lastSql: '',
    lastParams: [] as unknown[],
    rows: [] as unknown[],
    runCalls: [] as { sql: string; params: unknown[] }[],
    runChangesQueue: [] as number[]
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => {
        state.lastSql = sql
        return {
          all: (...params: unknown[]) => {
            state.lastParams = params
            return state.rows
          },
          run: (...params: unknown[]) => {
            state.runCalls.push({ sql, params })
            return { changes: state.runChangesQueue.shift() ?? 0 }
          }
        }
      }
    })
  }
}))

import { kbAskSessionRepo } from '../src/main/db/repositories/kb-ask-session.repo'

beforeEach(() => {
  state.lastSql = ''
  state.lastParams = []
  state.rows = []
  state.runCalls = []
  state.runChangesQueue = []
})

const baseRow = {
  id: 's1',
  kb_id: 'kb1',
  title: 'RAG 是什么',
  messages_json: JSON.stringify([
    { role: 'user', content: 'RAG 是什么？' },
    { role: 'assistant', content: '检索增强生成。' }
  ]),
  provider_id: 'p1',
  model: 'gpt-test',
  created_at: 100,
  updated_at: 200
}

describe('searchByKb — KB 问答会话搜索', () => {
  it('非空关键词 → LIKE 匹配标题与消息体', () => {
    state.rows = [baseRow]
    const result = kbAskSessionRepo.searchByKb('kb1', 'RAG')
    expect(state.lastSql).toContain('title LIKE ?')
    expect(state.lastSql).toContain('messages_json LIKE ?')
    expect(state.lastSql).toContain('ORDER BY updated_at DESC')
    expect(state.lastParams).toEqual(['kb1', '%RAG%', '%RAG%'])
    expect(result).toHaveLength(1)
    expect(result[0]!.id).toBe('s1')
    expect(result[0]!.title).toBe('RAG 是什么')
    expect(result[0]!.messageCount).toBe(2)
  })

  it('空关键词 → 回退全量列表（无 LIKE）', () => {
    state.rows = [baseRow]
    kbAskSessionRepo.searchByKb('kb1', '   ')
    expect(state.lastSql).not.toContain('LIKE')
    expect(state.lastParams).toEqual(['kb1'])
  })

  it('空白关键词 → 同样回退全量列表', () => {
    state.rows = [baseRow]
    kbAskSessionRepo.searchByKb('kb1', '')
    expect(state.lastSql).not.toContain('LIKE')
    expect(state.lastParams).toEqual(['kb1'])
  })

  it('无匹配行 → 返回空数组', () => {
    state.rows = []
    expect(kbAskSessionRepo.searchByKb('kb1', '不存在的词')).toEqual([])
  })

  it('非法 messages_json → messageCount 为 0（容错解析）', () => {
    state.rows = [{ ...baseRow, messages_json: 'not-json' }]
    const result = kbAskSessionRepo.searchByKb('kb1', 'x')
    expect(result[0]!.messageCount).toBe(0)
  })
})

describe('prune — 按保留策略清理', () => {
  it('仅 keepDays：删除 updated_at 早于阈值的会话', () => {
    state.runChangesQueue = [3]
    const before = Date.now()
    const deleted = kbAskSessionRepo.prune('kb1', { keepCount: 0, keepDays: 30 })
    expect(deleted).toBe(3)
    expect(state.runCalls).toHaveLength(1)
    const call = state.runCalls[0]!
    expect(call.sql).toContain('updated_at < ?')
    expect(call.params[0]).toBe('kb1')
    const cutoff = call.params[1] as number
    expect(cutoff).toBeLessThanOrEqual(before - 30 * 86_400_000 + 1000)
    expect(cutoff).toBeGreaterThan(Date.now() - 31 * 86_400_000)
  })

  it('仅 keepCount：仅保留最近 N 条（NOT IN + LIMIT）', () => {
    state.runChangesQueue = [2]
    const deleted = kbAskSessionRepo.prune('kb1', { keepCount: 100, keepDays: 0 })
    expect(deleted).toBe(2)
    expect(state.runCalls).toHaveLength(1)
    const call = state.runCalls[0]!
    expect(call.sql).toContain('NOT IN')
    expect(call.sql).toContain('LIMIT ?')
    expect(call.params).toEqual(['kb1', 'kb1', 100])
  })

  it('双策略：两条 DELETE 依次执行，返回合计删除数', () => {
    state.runChangesQueue = [1, 4]
    const deleted = kbAskSessionRepo.prune('kb1', { keepCount: 50, keepDays: 90 })
    expect(deleted).toBe(5)
    expect(state.runCalls).toHaveLength(2)
    expect(state.runCalls[0]!.sql).toContain('updated_at < ?')
    expect(state.runCalls[1]!.sql).toContain('NOT IN')
  })

  it('双 0（关闭）：不执行任何 DELETE，返回 0', () => {
    const deleted = kbAskSessionRepo.prune('kb1', { keepCount: 0, keepDays: 0 })
    expect(deleted).toBe(0)
    expect(state.runCalls).toHaveLength(0)
  })
})

describe('listAll / searchAll — 跨库漫游', () => {
  const roamRow = { ...baseRow, kb_name: '产品资料库' }

  it('listAll：LEFT JOIN knowledge_bases 带库名，ORDER BY updated_at DESC + LIMIT', () => {
    state.rows = [roamRow]
    const result = kbAskSessionRepo.listAll(200)
    expect(state.lastSql).toContain('LEFT JOIN knowledge_bases')
    expect(state.lastSql).toContain('ORDER BY s.updated_at DESC')
    expect(state.lastSql).toContain('LIMIT ?')
    expect(state.lastParams).toEqual([200])
    expect(result).toHaveLength(1)
    expect(result[0]!.kbName).toBe('产品资料库')
    expect(result[0]!.id).toBe('s1')
  })

  it('searchAll：LIKE 参数在前、LIMIT 在后', () => {
    state.rows = [roamRow]
    kbAskSessionRepo.searchAll('RAG', 100)
    expect(state.lastSql).toContain('s.title LIKE ?')
    expect(state.lastSql).toContain('s.messages_json LIKE ?')
    expect(state.lastParams).toEqual(['%RAG%', '%RAG%', 100])
  })

  it('searchAll 空白关键词 → 回退 listAll', () => {
    state.rows = [roamRow]
    kbAskSessionRepo.searchAll('   ', 50)
    expect(state.lastSql).not.toContain('LIKE')
    expect(state.lastParams).toEqual([50])
  })

  it('kb_name 为 null（库已删的防御场景）→ kbName 回落空串', () => {
    state.rows = [{ ...baseRow, kb_name: null }]
    const result = kbAskSessionRepo.listAll(200)
    expect(result[0]!.kbName).toBe('')
  })
})
