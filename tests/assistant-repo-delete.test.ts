// assistantRepo.delete 的行为契约：删助手只解绑，不删用户的对话
//
// 这条测试是补出来的：旧实现一边在 UI 上承诺「其历史会话仍会保留」，
// 一边 `DELETE FROM conversations/messages/messages_fts` —— 文案与代码相反，
// 且删除是不可恢复的数据丢失。现在锁定「保留」这一侧，防回退。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    runSqls: [] as string[],
    runParams: [] as unknown[][],
    assistantRow: undefined as unknown,
    transactionRuns: 0
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: (...params: unknown[]) => {
          // assistants 行存在性查询由 this.get() 走这里；其它语句不取行
          state.runSqls.push(sql)
          state.runParams.push(params)
          return sql.startsWith('SELECT * FROM assistants') ? state.assistantRow : undefined
        },
        run: (...params: unknown[]) => {
          state.runSqls.push(sql)
          state.runParams.push(params)
          return { changes: 1 }
        },
        all: () => []
      }),
      transaction: (fn: () => unknown) => () => {
        state.transactionRuns++
        return fn()
      }
    })
  }
}))

import { assistantRepo } from '../src/main/db/repositories/assistant.repo'

const asstRow = (isBuiltin: number) => ({
  id: 'a-1',
  name: '写作助手',
  description: null,
  avatar: null,
  system_prompt: null,
  default_provider_id: null,
  default_model: null,
  default_params: null,
  tool_permissions: null,
  skill_ids: null,
  knowledge_base_ids: null,
  welcome_message: null,
  is_builtin: isBuiltin,
  is_pinned: 0,
  created_at: 1,
  updated_at: 1
})

beforeEach(() => {
  state.runSqls = []
  state.runParams = []
  state.assistantRow = asstRow(0)
  state.transactionRuns = 0
})

const writes = () => state.runSqls.filter((s) => /^(UPDATE|DELETE)/.test(s))

describe('assistantRepo.delete', () => {
  it('不再删除任何会话或消息', () => {
    assistantRepo.delete('a-1')
    expect(writes().some((s) => /DELETE FROM (conversations|messages)/.test(s))).toBe(false)
  })

  it('会话解绑回自由会话，并一起清掉分组（组按助手过滤，留着旧组会话会在列表里隐身）', () => {
    assistantRepo.delete('a-1')
    expect(writes()[0]).toBe('UPDATE conversations SET assistant_id=NULL, group_id=NULL WHERE assistant_id=?')
    expect(state.runParams[1]).toEqual(['a-1'])
  })

  it('删掉该助手的分组文件夹，再删助手本身', () => {
    assistantRepo.delete('a-1')
    expect(writes()).toEqual([
      'UPDATE conversations SET assistant_id=NULL, group_id=NULL WHERE assistant_id=?',
      'DELETE FROM conversation_groups WHERE assistant_id=?',
      'DELETE FROM assistants WHERE id=?'
    ])
  })

  it('三步在一个事务里（中途崩溃不会留下"助手没了、会话还挂着它"的半态）', () => {
    assistantRepo.delete('a-1')
    expect(state.transactionRuns).toBe(1)
  })

  it('内置助手仍拒绝删除，且不执行任何写', () => {
    state.assistantRow = asstRow(1)
    expect(() => assistantRepo.delete('a-1')).toThrow('内置助手不可删除')
    expect(writes()).toEqual([])
  })

  it('助手不存在 → 直接返回，不碰数据库', () => {
    state.assistantRow = undefined
    assistantRepo.delete('ghost')
    expect(writes()).toEqual([])
    expect(state.transactionRuns).toBe(0)
  })
})
