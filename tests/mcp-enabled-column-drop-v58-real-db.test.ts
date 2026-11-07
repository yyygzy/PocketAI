// v58：删除 mcp_servers.enabled 的真库迁移用例。
//
// 为什么要在真库上测：
//  · 守卫靠 `PRAGMA table_info` 判断列在不在，mock 掉的 db 碰不到真实 schema；
//  · DROP COLUMN 是 schema 变更，只有真 SQLite 才能证明"列真没了"；
//  · 本仓库测试惯例是删掉 schema_migrations 行再跑一遍，守卫若不生效这里会直接抛。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-enabled-v58'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'

function colsOf(table: string): Array<{ name: string }> {
  return dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
}

function versionRow(version: number): { name: string } | undefined {
  return dbService
    .getHandle()
    .prepare('SELECT name FROM schema_migrations WHERE version=?')
    .get(version) as { name: string } | undefined
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
    /* 关不掉不掩盖结论 */
  }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch {
    /* scratch 残留由 CI 的临时目录承担 */
  }
})

describe('v58 删除 mcp_servers.enabled', () => {
  it('全新库跑到 v58：列不存在，且版本号落在 58', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(58)
    expect(colsOf('mcp_servers').map((c) => c.name)).not.toContain('enabled')
    expect(versionRow(58)?.name).toBe('drop_mcp_servers_enabled')
  })

  it('有 enabled 列时删列成功；原行 name/env/headers 逐字不变', () => {
    const db = dbService.getHandle()
    // 还原 v57 形状：v58 已删列，这里把它加回来（数值故意留 0，证明删的是真列而不是"从没读过"）
    db.exec('ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
    const rec = mcpServerRepo.save({
      name: 'legacy-off',
      transport: 'http',
      url: 'https://example.com/mcp'
    })
    // 直写历史明文（明文模式下新建密钥会被闸门拦下，这里只验证删列不改写其他列的字节）
    db.prepare('UPDATE mcp_servers SET enabled=0, env=?, headers=? WHERE id=?').run(
      '{"API_KEY":"sk-v58"}',
      '{"Authorization":"Bearer v58-check"}',
      rec.id
    )
    const before = db
      .prepare('SELECT name, env, headers FROM mcp_servers WHERE id=?')
      .get(rec.id) as { name: string; env: string | null; headers: string | null }

    // 退回版本号重跑：这就是测试惯例里的"再跑一遍"
    db.prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()

    expect(colsOf('mcp_servers').map((c) => c.name), '列应已被真删除').not.toContain('enabled')
    expect(versionRow(58)?.name).toBe('drop_mcp_servers_enabled')
    const after = db
      .prepare('SELECT name, env, headers FROM mcp_servers WHERE id=?')
      .get(rec.id) as { name: string; env: string | null; headers: string | null }
    expect(after, '删列不该重写其他列的内容').toEqual(before)
    const readBack = mcpServerRepo.get(rec.id)
    expect(readBack?.name).toBe('legacy-off')
    expect(readBack?.headers).toEqual({ Authorization: 'Bearer v58-check' })
  })

  it('守卫：列已不存在时再跑一遍不抛（DROP COLUMN 没有 IF EXISTS）', () => {
    dbService.getHandle().prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(colsOf('mcp_servers').map((c) => c.name)).not.toContain('enabled')
    expect(versionRow(58)?.name).toBe('drop_mcp_servers_enabled')
  })
})
