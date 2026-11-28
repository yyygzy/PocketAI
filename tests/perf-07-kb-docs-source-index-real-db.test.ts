// PERF-07：v85 迁移在真库上建出 kb_documents(source) 索引，附件清理查询走该索引
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-docs-source-index'
  return { dir, db: dir + sep + 'app.db' }
})
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'

const INDEX = 'idx_kb_docs_source'

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

describe('PERF-07 · v85 source 索引（真库）', () => {
  it('迁移版本推进到 >=85 且索引存在', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(85)
    const row = dbService
      .getHandle()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
      .get(INDEX)
    expect(row).toBeTruthy()
  })

  it('listIdsBySource 的查询计划命中该索引，不是 SCAN', () => {
    const plan = dbService
      .getHandle()
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM kb_documents WHERE source=?')
      .all('msg_m1') as Array<{ detail: string }>
    const detail = plan.map((r) => r.detail).join(' ; ')
    expect(detail).toContain(`USING INDEX ${INDEX}`)
    expect(detail).not.toContain('SCAN kb_documents')
  })

  it('删掉 schema_migrations 的 v85 行后重跑迁移是幂等的', () => {
    dbService.getHandle().prepare('DELETE FROM schema_migrations WHERE version=85').run()
    dbService.runMigrations()
    expect(kbDocRepo.listIdsBySource('msg_unknown')).toEqual([])
    const row = dbService
      .getHandle()
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
      .get(INDEX)
    expect(row).toBeTruthy()
  })
})
