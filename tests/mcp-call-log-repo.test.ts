// mcp-call-log.repo：写入即裁剪、按 server 查询、清空
//
// 这张表是「只有主进程能写、面板只读」的历史记录，最容易写坏的两处是
// 环形裁剪（不裁就无限长）与 limit 参数（渲染端传什么都有可能）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    sqls: [] as string[],
    params: [] as unknown[][],
    rows: [] as unknown[],
    changes: 1
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        run: (...params: unknown[]) => {
          state.sqls.push(sql)
          state.params.push(params)
          return { changes: state.changes }
        },
        all: (...params: unknown[]) => {
          state.sqls.push(sql)
          state.params.push(params)
          return state.rows
        }
      }),
      transaction: (fn: () => unknown) => () => fn()
    })
  }
}))

import {
  mcpCallLogRepo,
  KEEP_PER_SERVER,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT
} from '../src/main/db/repositories/mcp-call-log.repo'
import type { McpCallEvent } from '../src/shared/types'

const evt = (over: Partial<McpCallEvent> = {}): McpCallEvent => ({
  serverId: 'srv-1',
  tool: 'fetch',
  ok: true,
  durationMs: 1234.6,
  argsPreview: 'url="https://a"',
  resultPreview: '正文',
  error: null,
  ...over
})

beforeEach(() => {
  state.sqls = []
  state.params = []
  state.rows = []
  state.changes = 1
})

describe('mcpCallLogRepo.append', () => {
  it('一次调用写两条语句：插入 + 按 server 裁剪到上限', () => {
    mcpCallLogRepo.append(evt())
    expect(state.sqls).toHaveLength(2)
    expect(state.sqls[0]).toContain('INSERT INTO mcp_call_log')
    expect(state.sqls[1]).toContain('DELETE FROM mcp_call_log')
    expect(state.sqls[1]).toContain('ORDER BY created_at DESC, id DESC LIMIT ?')
  })

  it('落库字段形状：ok 存 0/1、耗时取整非负、可空列存 NULL', () => {
    mcpCallLogRepo.append(evt({ ok: false, durationMs: -5, argsPreview: null, resultPreview: null, error: 'boom' }))
    const params = state.params[0]!
    expect(params[1]).toBe('fetch')
    expect(params[2]).toBe(0)
    expect(params[3]).toBe(0) // 负数夹到 0
    expect(params[4]).toBeNull()
    expect(params[5]).toBeNull()
    expect(params[6]).toBe('boom')
    expect(typeof params[7]).toBe('number')
  })

  it('耗时四舍五入，不存小数', () => {
    mcpCallLogRepo.append(evt({ durationMs: 1234.6 }))
    expect(state.params[0]![3]).toBe(1235)
  })

  it('裁剪语句与插入同一个 serverId（不会把别的 server 的记录裁掉）', () => {
    mcpCallLogRepo.append(evt({ serverId: 'srv-9' }))
    expect(state.params[1]).toEqual(['srv-9', 'srv-9', KEEP_PER_SERVER])
  })

  it('空 serverId 走 schema 抛错，不拼进 SQL', () => {
    expect(() => mcpCallLogRepo.append(evt({ serverId: '' }))).toThrow()
    expect(state.sqls).toEqual([])
  })
})

describe('mcpCallLogRepo.list / clear', () => {
  it('给定 server → 带过滤；省略 → 全部（两条 SQL 不同，别写串）', () => {
    mcpCallLogRepo.list('srv-1', 10)
    expect(state.sqls[0]).toContain('WHERE server_id = ?')
    expect(state.params[0]).toEqual(['srv-1', 10])
    mcpCallLogRepo.list(null)
    expect(state.sqls[1]).not.toContain('WHERE')
    expect(state.params[1]).toEqual([DEFAULT_LIST_LIMIT])
  })

  it('limit 夹到 1–1000，脏值回落默认条数', () => {
    mcpCallLogRepo.list(null, 999_999)
    expect(state.params[0]![0]).toBe(MAX_LIST_LIMIT)
    mcpCallLogRepo.list(null, 0)
    expect(state.params[1]![0]).toBe(DEFAULT_LIST_LIMIT)
    mcpCallLogRepo.list(null, Number.NaN)
    expect(state.params[2]![0]).toBe(DEFAULT_LIST_LIMIT)
    mcpCallLogRepo.list(null, -3)
    expect(state.params[3]![0]).toBe(DEFAULT_LIST_LIMIT)
  })

  it('行映射：ok 的 0/1 还原成布尔、缺列回落 null', () => {
    state.rows = [
      {
        id: 7,
        server_id: 'srv-1',
        tool: 'fetch',
        ok: 0,
        duration_ms: 20,
        args_preview: null,
        result_preview: undefined,
        error: 'boom',
        created_at: 111
      }
    ]
    const [rec] = mcpCallLogRepo.list('srv-1')
    expect(rec).toEqual({
      id: 7,
      serverId: 'srv-1',
      tool: 'fetch',
      ok: false,
      durationMs: 20,
      argsPreview: null,
      resultPreview: null,
      error: 'boom',
      createdAt: 111
    })
  })

  it('clear 传 server 只清该 server，省略则全清；返回删除条数', () => {
    state.changes = 4
    expect(mcpCallLogRepo.clear('srv-1')).toBe(4)
    expect(state.sqls[0]).toBe('DELETE FROM mcp_call_log WHERE server_id = ?')
    expect(mcpCallLogRepo.clear()).toBe(4)
    expect(state.sqls[1]).toBe('DELETE FROM mcp_call_log')
  })
})
