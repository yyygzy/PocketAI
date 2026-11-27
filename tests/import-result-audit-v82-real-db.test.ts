// v82 `import_result_audits` 真实库路径：
//   · 空库跑到最新 → 表/索引存在、迁移登记为 v82；
//   · 审计仓储能落库并按 kind 读回（只存来源/校验状态/计数/错误码，不存正文或凭据值）；
//   · 删掉 v82 登记再跑 → 幂等空操作，既有审计不丢。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-import-result-audit-v82'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { importResultAuditRepo } from '../src/main/db/repositories/import-result-audit.repo'

function db(): ReturnType<typeof dbService.getHandle> {
  return dbService.getHandle()
}

function columns(table: string): string[] {
  return (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try { dbService.close() } catch { /* ignore */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('v82 空库升级', () => {
  it('表与索引存在、迁移登记齐全、结构里没有正文或凭据列', () => {
    expect(columns('import_result_audits')).toEqual(
      expect.arrayContaining([
        'id', 'kind', 'source', 'source_detail', 'checksum', 'ok', 'error_code',
        'imported_count', 'failed_count', 'cleared_key_count', 'created_at'
      ])
    )
    const cols = columns('import_result_audits')
    for (const forbidden of ['raw', 'body', 'content', 'env', 'headers', 'examples']) {
      expect(cols).not.toContain(forbidden)
    }
    expect(db().prepare('SELECT name FROM schema_migrations WHERE version=82').get()).toEqual({
      name: 'import_result_audits'
    })
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(82)
    const indexes = (db().prepare('PRAGMA index_list(import_result_audits)').all() as Array<{ name: string }>).map((i) => i.name)
    expect(indexes).toContain('idx_import_result_audits_kind_at')
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })
})

describe('审计仓储', () => {
  it('落库后能按 kind 读回计数与错误码，字符串被截断且不存敏感值', () => {
    expect(
      importResultAuditRepo.insert({
        kind: 'mcp',
        source: 'paste',
        sourceDetail: `x${'Y'.repeat(1200)}`,
        checksum: 'absent',
        ok: false,
        errorCode: 'PARSE_FAILED',
        importedCount: 0,
        failedCount: 2,
        clearedKeyCount: 3
      })
    ).toBe(true)

    const rows = importResultAuditRepo.listByKind('mcp')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'mcp',
      source: 'paste',
      checksum: 'absent',
      ok: false,
      errorCode: 'PARSE_FAILED',
      importedCount: 0,
      failedCount: 2,
      clearedKeyCount: 3
    })
    expect(rows[0]!.sourceDetail).toHaveLength(1000)
    expect(JSON.stringify(rows[0])).not.toContain('API_KEY')
    expect(rows[0]!.createdAt).toBeGreaterThan(0)
  })

  it('删掉 v82 登记再跑：空操作，既有审计不丢', () => {
    const before = importResultAuditRepo.listByKind('mcp')
    db().prepare('DELETE FROM schema_migrations WHERE version=82').run()

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(importResultAuditRepo.listByKind('mcp')).toEqual(before)
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })
})
