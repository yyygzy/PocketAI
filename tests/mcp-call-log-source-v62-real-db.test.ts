// v62 `mcp_call_log.source` 真实库路径（V4-Iter-469）：
//   · 空库直接跑到最新版 → 有 source 列，且版本号推进到 62；
//   · 老库形状（无 source 列）升级 → 加列成功，历史行按 agent 读，新写入能区分 manual；
//   · 删掉 v62 登记再跑 → 幂等空操作，既有行不丢。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-call-source-v62'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'

function db(): ReturnType<typeof dbService.getHandle> {
  return dbService.getHandle()
}

function columns(table: string): string[] {
  return (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function insertLegacyRow(tool: string): void {
  db()
    .prepare(
      `INSERT INTO mcp_call_log
       (server_id, tool, ok, duration_ms, args_preview, result_preview, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('srv-legacy', tool, 1, 12, 'a=1', 'ok', null, 1_700_000_000_000)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  db().prepare('DELETE FROM mcp_call_log').run()
})

describe('v62 空库升级', () => {
  it('有 source 列、迁移登记齐全、版本号推进到 62', () => {
    expect(columns('mcp_call_log')).toContain('source')
    expect(db().prepare('SELECT name FROM schema_migrations WHERE version=62').get()).toEqual({
      name: 'mcp_call_log_source'
    })
    expect(LATEST_SCHEMA_VERSION).toBe(62)
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })
})

describe('v62 老库升级（无 source 列）', () => {
  it('加列后历史行走 default=agent，manual 只有新写入才有', () => {
    // 回到「v61 已跑完、v62 还没跑」的形状：删列 + 删登记 + 先塞一行历史数据
    db().exec('ALTER TABLE mcp_call_log DROP COLUMN source;')
    db().prepare('DELETE FROM schema_migrations WHERE version=62').run()
    insertLegacyRow('legacy_fetch')

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(columns('mcp_call_log')).toContain('source')

    const legacy = db()
      .prepare('SELECT tool, source FROM mcp_call_log WHERE tool=?')
      .get('legacy_fetch')
    expect(legacy).toEqual({ tool: 'legacy_fetch', source: 'agent' })

    db()
      .prepare(
        `INSERT INTO mcp_call_log
         (server_id, tool, source, ok, duration_ms, args_preview, result_preview, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('srv-manual', 'manual_fetch', 'manual', 1, 3, null, null, null, 1_700_000_000_001)

    const rows = db()
      .prepare('SELECT tool, source FROM mcp_call_log ORDER BY created_at')
      .all()
    expect(rows).toEqual([
      { tool: 'legacy_fetch', source: 'agent' },
      { tool: 'manual_fetch', source: 'manual' }
    ])
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('删掉 v62 登记再跑：空操作，历史行与 source 值不变', () => {
    insertLegacyRow('rerun_fetch')
    db().prepare('DELETE FROM schema_migrations WHERE version=62').run()

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(db().prepare('SELECT tool, source FROM mcp_call_log').all()).toEqual([
      { tool: 'rerun_fetch', source: 'agent' }
    ])
  })
})
