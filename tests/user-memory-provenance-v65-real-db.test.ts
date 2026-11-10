// v65 `user_memory` 来源/软删除真实库路径：
//   · 空库直接跑到最新版 → 三列齐全、老行读出来是 legacy；
//   · v64 形状（没有这三列）升级 → 只加列，既有内容一行不动；
//   · 删掉 schema_migrations v65 行再跑 → 空操作（可重跑）；
//   · 两条写入路径的来源/会话落地、软删除不参与召回、恢复后重新参与；
//   · 活跃行数上限拒绝写入/恢复，且不清理既有数据。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-user-memory-v65'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import { userMemoryRepo } from '../src/main/db/repositories/user-memory.repo'
import { buildMemoryContext } from '../src/main/assistant/memory'
import { MEMORY_MAX_ROWS } from '../src/shared/schemas/memory'

function db(): ReturnType<typeof dbService.getHandle> {
  return dbService.getHandle()
}

function columns(): Set<string> {
  return new Set(
    (db().prepare('PRAGMA table_info(user_memory)').all() as Array<{ name: string }>).map((c) => c.name)
  )
}

function rawRow(id: string): {
  source: string
  conversation_id: string | null
  deleted_at: number | null
} | undefined {
  return db().prepare('SELECT source, conversation_id, deleted_at FROM user_memory WHERE id=?').get(id) as
    | { source: string; conversation_id: string | null; deleted_at: number | null }
    | undefined
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
  db().prepare('DELETE FROM user_memory').run()
})

describe('v65 空库升级', () => {
  it('三列齐全、迁移登记齐全，且是最新版本', () => {
    expect(columns()).toEqual(new Set(['id', 'content', 'created_at', 'updated_at', 'source', 'conversation_id', 'deleted_at']))
    expect(db().prepare('SELECT name FROM schema_migrations WHERE version=65').get()).toEqual({
      name: 'user_memory_provenance'
    })
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(65)
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('历史行（不带来源插入）读出来是 legacy / null / null', () => {
    db()
      .prepare('INSERT INTO user_memory (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('legacy-1', '迁移前就存在的记忆', 100, 200)
    expect(rawRow('legacy-1')).toEqual({ source: 'legacy', conversation_id: null, deleted_at: null })
  })
})

describe('v65 从 v64 形状升级 + 幂等', () => {
  it('重建成 v64 形状再跑迁移：只加列，既有内容不变', () => {
    db()
      .prepare('INSERT INTO user_memory (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('old-1', '老记忆', 100, 200)
    // v65 的 source 自带 CHECK，SQLite 不允许直接 DROP；按 v64 的建表语句重建，保留原数据
    db().exec(`
      CREATE TABLE user_memory_v64 (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO user_memory_v64 (id, content, created_at, updated_at)
        SELECT id, content, created_at, updated_at FROM user_memory;
      DROP TABLE user_memory;
      ALTER TABLE user_memory_v64 RENAME TO user_memory;
      CREATE INDEX IF NOT EXISTS idx_user_memory_updated_at ON user_memory(updated_at DESC);
    `)
    db().prepare('DELETE FROM schema_migrations WHERE version=65').run()
    expect(columns()).toEqual(new Set(['id', 'content', 'created_at', 'updated_at']))

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(columns()).toEqual(new Set(['id', 'content', 'created_at', 'updated_at', 'source', 'conversation_id', 'deleted_at']))
    expect(db().prepare('SELECT content FROM user_memory WHERE id=?').get('old-1')).toEqual({ content: '老记忆' })
    expect(rawRow('old-1')).toEqual({ source: 'legacy', conversation_id: null, deleted_at: null })
  })

  it('删掉 v65 登记再跑：空操作，既有行不丢', () => {
    userMemoryRepo.add('重跑前写入', { source: 'agent', conversationId: 'conv-keep' })
    db().prepare('DELETE FROM schema_migrations WHERE version=65').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(userMemoryRepo.list()).toHaveLength(1)
    expect(userMemoryRepo.list()[0]).toEqual(
      expect.objectContaining({ content: '重跑前写入', source: 'agent', conversationId: 'conv-keep' })
    )
  })
})

describe('来源 / 软删除 / 恢复', () => {
  it('设置页手写 → user + null 会话', () => {
    const rec = userMemoryRepo.add('手写记忆')
    expect(rec.source).toBe('user')
    expect(rec.conversationId).toBeNull()
  })

  it('Agent 写入 → agent + 会话 id', () => {
    const rec = userMemoryRepo.add('Agent 记忆', { source: 'agent', conversationId: 'conv-42' })
    expect(rec.source).toBe('agent')
    expect(rec.conversationId).toBe('conv-42')
    expect(rawRow(rec.id)).toEqual({ source: 'agent', conversation_id: 'conv-42', deleted_at: null })
  })

  it('软删除：列表与召回都不再包含，行仍在库中', () => {
    const rec = userMemoryRepo.add('将要删除的记忆')
    expect(buildMemoryContext()).toContain('将要删除的记忆')

    userMemoryRepo.remove(rec.id)
    expect(userMemoryRepo.list()).toEqual([])
    expect(buildMemoryContext()).not.toContain('将要删除的记忆')
    expect(rawRow(rec.id)?.deleted_at).toBeTypeOf('number')
  })

  it('恢复后重新参与召回', () => {
    const rec = userMemoryRepo.add('删除后恢复的记忆')
    userMemoryRepo.remove(rec.id)
    userMemoryRepo.restore(rec.id)
    expect(userMemoryRepo.list().map((m) => m.id)).toEqual([rec.id])
    expect(buildMemoryContext()).toContain('删除后恢复的记忆')
  })

  it('purge 才是物理删除（明确清理动作）', () => {
    const rec = userMemoryRepo.add('待清理')
    userMemoryRepo.remove(rec.id)
    userMemoryRepo.purge(rec.id)
    expect(userMemoryRepo.get(rec.id)).toBeNull()
  })

  it('已删除列表可读；批量清理只删指定行并返回行数', () => {
    const a = userMemoryRepo.add('删除 A')
    const b = userMemoryRepo.add('删除 B')
    const keep = userMemoryRepo.add('保留')
    userMemoryRepo.remove(a.id)
    userMemoryRepo.remove(b.id)

    expect(userMemoryRepo.listDeleted().map((m) => m.id).sort()).toEqual([a.id, b.id].sort())

    expect(userMemoryRepo.purgeMany([a.id, b.id])).toBe(2)
    expect(userMemoryRepo.listDeleted()).toEqual([])
    expect(userMemoryRepo.list().map((m) => m.id)).toEqual([keep.id])
    expect(userMemoryRepo.get(a.id)).toBeNull()
  })
})

describe('活跃行数上限', () => {
  it('达上限拒绝写入，软删除一条后可再写；恢复会再次触顶', () => {
    const insert = db().prepare(
      'INSERT INTO user_memory (id, content, source, conversation_id, deleted_at, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)'
    )
    const seed = db().transaction(() => {
      for (let i = 0; i < MEMORY_MAX_ROWS; i++) {
        insert.run(`seed-${i}`, `记忆 ${i}`, 'user', i, i)
      }
    })
    seed()
    expect(userMemoryRepo.count()).toBe(MEMORY_MAX_ROWS)

    expect(() => userMemoryRepo.add('第 1001 条')).toThrow(`记忆条目已达上限（${MEMORY_MAX_ROWS} 条）`)
    // 既有数据一条不少
    expect(db().prepare('SELECT COUNT(*) AS n FROM user_memory').get()).toEqual({ n: MEMORY_MAX_ROWS })

    userMemoryRepo.remove('seed-0')
    expect(userMemoryRepo.count()).toBe(MEMORY_MAX_ROWS - 1)
    expect(() => userMemoryRepo.add('补进来的第 1000 条')).not.toThrow()

    expect(() => userMemoryRepo.restore('seed-0')).toThrow(`记忆条目已达上限（${MEMORY_MAX_ROWS} 条）`)
    expect(rawRow('seed-0')?.deleted_at).toBeTypeOf('number')
  })
})
