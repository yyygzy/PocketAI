// v77：mcp_servers.auto_connect / catalog_id 的真库迁移与仓储用例。
//
// 重点证明：
//  · 迁移幂等（SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，必须靠 PRAGMA 守卫）；
//  · 旧记录/新建记录默认 autoConnect=false，升级后不会被静默拉起；
//  · 显式安装（catalogId）与启用（autoConnect=true）能持久化并被读回。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-autoconnect-v77'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'

function colsOf(table: string): Array<{ name: string }> {
  return dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
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

describe('v77 连接器自动连接字段', () => {
  it('全新库跑到 ≥ v77：列存在，迁移记录在', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(77)
    const cols = colsOf('mcp_servers').map((c) => c.name)
    expect(cols).toContain('auto_connect')
    expect(cols).toContain('catalog_id')
    expect(versionRow(77)?.name).toBe('mcp_auto_connect_catalog')
  })

  it('新建记录默认不自动连接', () => {
    const rec = mcpServerRepo.save({
      name: 'manual-default',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-time']
    })
    const read = mcpServerRepo.get(rec.id)
    expect(read?.autoConnect).toBe(false)
    expect(read?.catalogId).toBeNull()
  })

  it('目录安装/显式启用能持久化，setAutoConnect 可单独停用', () => {
    const rec = mcpServerRepo.save({
      name: 'memory',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      autoConnect: true,
      catalogId: 'memory'
    })
    const read = mcpServerRepo.get(rec.id)
    expect(read?.autoConnect).toBe(true)
    expect(read?.catalogId).toBe('memory')

    mcpServerRepo.setAutoConnect(rec.id, false)
    expect(mcpServerRepo.get(rec.id)?.autoConnect).toBe(false)
    // 其余字段不受影响
    expect(mcpServerRepo.get(rec.id)?.catalogId).toBe('memory')
  })

  it('更新配置时未提交 autoConnect/catalogId 会沿用旧值（避免编辑表单误清）', () => {
    const rec = mcpServerRepo.save({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      autoConnect: true,
      catalogId: 'filesystem'
    })
    const existing = mcpServerRepo.get(rec.id)!
    mcpServerRepo.save({ ...existing, name: 'filesystem-renamed' })
    const read = mcpServerRepo.get(rec.id)
    expect(read?.name).toBe('filesystem-renamed')
    expect(read?.autoConnect).toBe(true)
    expect(read?.catalogId).toBe('filesystem')
  })

  it('迁移幂等：删掉 v77 记录再跑一遍不抛', () => {
    dbService.getHandle().prepare('DELETE FROM schema_migrations WHERE version=77').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(versionRow(77)?.name).toBe('mcp_auto_connect_catalog')
    expect(colsOf('mcp_servers').map((c) => c.name)).toContain('auto_connect')
  })
})
