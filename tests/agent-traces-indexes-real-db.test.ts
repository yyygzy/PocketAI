// agent_traces 的三张索引（migration v49，V4-Iter-168）——真库 + 真 EXPLAIN QUERY PLAN
//
// 为什么钉"执行计划"而不是钉"耗时"：耗时在这台机器上是 0.08–0.4ms 量级，CI 抖动一下就红，
// 那是 flake 不是缺陷；而"走没走索引"是**计划层面的确定事实**，同一个库同一个计划不会今天走明天不走。
//
// 三条要钉住的语义：
//  · 五类真实查询形状都必须 `USING INDEX`，一条 `SCAN agent_traces` 都不许有（163 的树聚合、
//    166 的级联删除是这次新增的两类读法，正是它们让"以后再说"变成"现在"）；
//  · 会话那支是**复合**索引 `(conversation_id, created_at)`：那两条读取都带 `ORDER BY created_at DESC`，
//    只建单列时计划里会剩一句 `USE TEMP B-TREE FOR ORDER BY`（实测多花 0.07ms 且随行数线性涨）；
//  · 幂等 + 从 v48 升上来能补建（同 v46/v48 那条规矩）。
//
// 最后一条"反向对照"是这套断言的牙：把三张索引 drop 掉再读一次计划，必须退回 SCAN——
// 否则"没有 SCAN"这个判据可能只是恒真（比如 SQL 拼错、根本没测到那张表）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-trace-index'
  return { dir, db: dir + sep + 'app.db' }
})
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'

const INDEXES = {
  idx_agent_traces_request: ['request_id'],
  idx_agent_traces_conversation: ['conversation_id', 'created_at'],
  idx_agent_traces_parent_request: ['parent_request_id']
} as const

/** 真实仓储在用 / 新增的查询形状（改一处仓储就该在这里跟着改） */
const SHAPES: Array<{ label: string; sql: string; args: string[] }> = [
  { label: 'listByRequest', sql: 'SELECT * FROM agent_traces WHERE request_id = ? ORDER BY step_index ASC', args: ['req-1'] },
  { label: '163 statsByRequest 树聚合', sql: 'SELECT COUNT(*) n FROM agent_traces WHERE request_id = ? OR parent_request_id = ?', args: ['req-1', 'req-1'] },
  { label: 'listByConversation', sql: 'SELECT * FROM agent_traces WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 100', args: ['conv-1'] },
  { label: 'latestRequestId', sql: 'SELECT request_id FROM agent_traces WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', args: ['conv-1'] },
  { label: '166 级联删除', sql: 'DELETE FROM agent_traces WHERE conversation_id = ?', args: ['conv-1'] },
  { label: '163 会话累计子查询', sql: 'SELECT request_id FROM agent_traces WHERE conversation_id = ?', args: ['conv-1'] }
]

function planOf(sql: string, args: string[]): string {
  return (dbService.getHandle().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
    .map((r) => r.detail).join(' ; ')
}

function indexesOn(table: string): Record<string, string[]> {
  const db = dbService.getHandle()
  const out: Record<string, string[]> = {}
  for (const r of db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; origin: string }>) {
    if (r.origin !== 'c') continue // 跳过主键/唯一约束自带的 autoindex
    out[r.name] = (db.prepare(`PRAGMA index_info(${r.name})`).all() as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno).map((c) => c.name)
  }
  return out
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('v49：agent_traces 的三张索引', () => {
  it('三张都在，列与列序都对（会话那支必须是复合）', () => {
    const got = indexesOn('agent_traces')
    for (const [name, cols] of Object.entries(INDEXES)) {
      expect(got[name], `缺索引 ${name}（实到：${Object.keys(got).join(', ')}）`).toEqual(cols)
    }
  })

  it('六类查询形状全部走索引，一条全表扫都不许有', () => {
    for (const s of SHAPES) {
      const p = planOf(s.sql, s.args)
      expect(p, `${s.label} 的计划里没有 USING INDEX：${p}`).toContain('USING INDEX')
      expect(p, `${s.label} 还在全表扫：${p}`).not.toContain('SCAN agent_traces')
    }
  })

  it('复合索引真的把那次排序消掉了（不是只让它"看起来"走了索引）', () => {
    const p = planOf(SHAPES[2]!.sql, SHAPES[2]!.args)
    expect(p, `还留着临时 B 树排序：${p}`).not.toContain('TEMP B-TREE')
  })

  it('幂等：重复跑迁移不抛（IF NOT EXISTS 的用处）', () => {
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(Object.keys(indexesOn('agent_traces')).sort()).toEqual(Object.keys(INDEXES).sort())
  })

  it('升级路径：v48 形状的库（无这三张索引）跑完迁移能补上', () => {
    const db = dbService.getHandle()
    for (const name of Object.keys(INDEXES)) db.prepare(`DROP INDEX ${name}`).run()
    db.prepare('DELETE FROM schema_migrations WHERE version = 49').run()
    expect(Object.keys(indexesOn('agent_traces')).length).toBe(0)

    dbService.runMigrations()

    expect(Object.keys(indexesOn('agent_traces')).sort()).toEqual(Object.keys(INDEXES).sort())
    expect((db.prepare('SELECT version FROM schema_migrations WHERE version = 49').get() as { version: number }).version).toBe(49)
  })

  it('反向对照：索引没了计划就退回 SCAN ⇒ 上面那两条断言不是恒真', () => {
    const db = dbService.getHandle()
    for (const name of Object.keys(INDEXES)) db.prepare(`DROP INDEX ${name}`).run()
    const scanned = SHAPES.filter((s) => planOf(s.sql, s.args).includes('SCAN agent_traces')).length
    expect(scanned, 'drop 掉索引后仍有查询走索引 ⇒ 判据测的不是这张表').toBe(SHAPES.length)
    // 复原。注意必须先退回 v49 那条迁移记录——版本门挡着，光跑 runMigrations() 不会重建
    // （这正是上面"重复跑迁移不抛"那条幂等的另一面：IF NOT EXISTS 不等于会自动补建）
    db.prepare('DELETE FROM schema_migrations WHERE version = 49').run()
    dbService.runMigrations()
    expect(planOf(SHAPES[0]!.sql, SHAPES[0]!.args)).toContain('USING INDEX')
  })

  // 这一条断言的是**当前最新迁移号**，不是 v49 本身：每加一条迁移都要跟着动（v50 = trace 三列，V4-Iter-232）。
  // 诊断模块那句「库结构是否落后」拿它当尺子，所以它必须等于迁移表的末尾，而不是等于本文件测的那批索引。
  it('版本号确实推进到当前最新一条迁移（诊断模块那句"库结构是否落后"依赖它）', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(50)
  })
})
