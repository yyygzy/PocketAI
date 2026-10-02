// conversation-group.repo 分组文件夹数据访问测试
//
// 覆盖 buildGroupListWhere 纯函数与 conversationGroupRepo 的 CRUD/解绑 SQL：
// mock dbService prepare().all/run 与 handle.transaction（捕获 SQL/参数，立即执行事务体）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    lastSql: '',
    lastParams: [] as unknown[],
    rows: [] as unknown[],
    runSqls: [] as string[],
    transactionRuns: 0 as number
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        all: (...params: unknown[]) => {
          state.lastSql = sql
          state.lastParams = params
          return state.rows
        },
        run: (...params: unknown[]) => {
          state.lastSql = sql
          state.lastParams = params
          state.runSqls.push(sql)
          return { changes: 1 }
        }
      }),
      transaction: (fn: () => unknown) => () => {
        state.transactionRuns++
        fn()
      }
    })
  }
}))

import { buildGroupListWhere, conversationGroupRepo } from '../src/main/db/repositories/conversation-group.repo'

beforeEach(() => {
  state.lastSql = ''
  state.lastParams = []
  state.rows = []
  state.runSqls = []
  state.transactionRuns = 0
})

describe('buildGroupListWhere — 助手过滤口径（与会话列表一致）', () => {
  it("asst-default：取 'asst-default' OR NULL，无绑定参数", () => {
    const q = buildGroupListWhere('asst-default')
    expect(q.where).toContain("assistant_id = 'asst-default' OR assistant_id IS NULL")
    expect(q.vals).toEqual([])
  })

  it('普通助手：精确匹配 + 绑定 id', () => {
    const q = buildGroupListWhere('asst-xyz')
    expect(q.where).toBe(' WHERE assistant_id = ?')
    expect(q.vals).toEqual(['asst-xyz'])
  })

  it('undefined：不加助手条件（全量）', () => {
    expect(buildGroupListWhere(undefined)).toEqual({ where: '', vals: [] })
  })
})

describe('conversationGroupRepo.list', () => {
  it('查四列 + 按 created_at ASC，参数透传，行映射 snake→camel', () => {
    state.rows = [{ id: 'g1', assistant_id: 'asst-default', name: '工作', created_at: 123 }]
    const list = conversationGroupRepo.list('asst-default')
    expect(state.lastSql).toContain('SELECT id, assistant_id, name, created_at FROM conversation_groups')
    expect(state.lastSql).toContain('ORDER BY created_at ASC')
    expect(state.lastParams).toEqual([])
    expect(list).toEqual([{ id: 'g1', assistantId: 'asst-default', name: '工作', createdAt: 123 }])
  })
})

describe('conversationGroupRepo.create', () => {
  it('INSERT 参数 [uuid, assistantId, name, ts]；返回记录，assistantId undefined→null', () => {
    const before = Date.now()
    const g = conversationGroupRepo.create({ name: '新项目' })
    expect(state.lastSql).toContain('INSERT INTO conversation_groups')
    expect(state.lastParams[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.lastParams[1]).toBeNull()
    expect(state.lastParams[2]).toBe('新项目')
    expect(state.lastParams[3]).toBeGreaterThanOrEqual(before)
    expect(g.id).toBe(state.lastParams[0])
    expect(g.assistantId).toBeNull()
    expect(g.name).toBe('新项目')
  })

  it('显式 assistantId 原样绑定', () => {
    conversationGroupRepo.create({ assistantId: 'asst-2', name: 'x' })
    expect(state.lastParams[1]).toBe('asst-2')
  })
})

describe('conversationGroupRepo.rename', () => {
  it('UPDATE name 按 id 绑定，参数顺序 [name, id]', () => {
    conversationGroupRepo.rename('g9', '新名字')
    expect(state.lastSql).toBe('UPDATE conversation_groups SET name=? WHERE id=?')
    expect(state.lastParams).toEqual(['新名字', 'g9'])
  })
})

describe('conversationGroupRepo.delete — 解散只解绑不删会话', () => {
  it('事务内先 UPDATE conversations 置 NULL，再 DELETE 组', () => {
    conversationGroupRepo.delete('g10')
    expect(state.transactionRuns).toBe(1)
    expect(state.runSqls).toHaveLength(2)
    expect(state.runSqls[0]).toContain('UPDATE conversations SET group_id=NULL WHERE group_id=?')
    expect(state.runSqls[1]).toBe('DELETE FROM conversation_groups WHERE id=?')
    // 两步都绑定组 id
    expect(state.lastParams).toEqual(['g10'])
  })
})

describe('conversationGroupRepo.setConversationGroup', () => {
  it('非空组：UPDATE group_id 绑定 [groupId, convId]', () => {
    conversationGroupRepo.setConversationGroup('c1', 'g2')
    expect(state.lastSql).toBe('UPDATE conversations SET group_id=? WHERE id=?')
    expect(state.lastParams).toEqual(['g2', 'c1'])
  })

  it('null：绑定 [null, convId] 即移出分组', () => {
    conversationGroupRepo.setConversationGroup('c2', null)
    expect(state.lastParams).toEqual([null, 'c2'])
  })
})
