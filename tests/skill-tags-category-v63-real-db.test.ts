// v63 `skills.tags` / `skills.category` 真实库路径：
//   · 空库直接跑到最新版 → 两列存在、默认值可读（tags='[]'、category=''）；
//   · 老库形状（无这两列）升级 → 加列成功，老技能经 skillRepo 读出空值而不是 null/undefined；
//   · 新写入能落库并原样读回（含带逗号的自由文本标签）；
//   · 删掉 v63 登记再跑 → 幂等空操作，既有值不变。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-skill-tags-v63'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { skillRepo } from '../src/main/db/repositories/skill.repo'

function db(): ReturnType<typeof dbService.getHandle> {
  return dbService.getHandle()
}

function columns(table: string): string[] {
  return (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function insertLegacySkill(id: string): void {
  db()
    .prepare(
      `INSERT INTO skills (id, name, description, icon, content, enabled, is_builtin, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?)`
    )
    .run(id, '老技能', '升级前就有', '⚡', '正文', 1_700_000_000_000)
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

describe('v63 空库升级', () => {
  it('两列存在、迁移登记齐全、默认值就是空值', () => {
    expect(columns('skills')).toEqual(expect.arrayContaining(['tags', 'category']))
    expect(db().prepare('SELECT name FROM schema_migrations WHERE version=63').get()).toEqual({
      name: 'skill_tags_category'
    })
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')

    insertLegacySkill('empty-default')
    const row = db().prepare('SELECT tags, category FROM skills WHERE id=?').get('empty-default')
    expect(row).toEqual({ tags: '[]', category: '' })
    expect(skillRepo.get('empty-default')).toMatchObject({ tags: [], category: '' })
  })
})

describe('v63 老库升级（无 tags/category 列）', () => {
  it('加列后老技能读出空值，新写入能区分自由文本分类与标签', () => {
    // 回到「v62 已跑完、v63 还没跑」的形状
    db().exec('ALTER TABLE skills DROP COLUMN tags;')
    db().exec('ALTER TABLE skills DROP COLUMN category;')
    db().prepare('DELETE FROM schema_migrations WHERE version=63').run()
    insertLegacySkill('legacy-v62')

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(columns('skills')).toEqual(expect.arrayContaining(['tags', 'category']))

    // 老行：读到的是空值（不是 null、也不是"无分类"这种缺失态）
    expect(skillRepo.get('legacy-v62')).toMatchObject({ tags: [], category: '' })

    // 新写入：分类是自由文本，标签用 JSON 存，含逗号也不被切碎
    const created = skillRepo.save({ name: '新技能', category: '开发', tags: ['code, review', '调试'] })
    expect(skillRepo.get(created.id)).toMatchObject({
      category: '开发',
      tags: ['code, review', '调试']
    })
    expect(db().pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('删掉 v63 登记再跑：空操作，既有分类/标签不变', () => {
    const before = skillRepo.list().map((s) => ({ id: s.id, category: s.category, tags: s.tags }))
    db().prepare('DELETE FROM schema_migrations WHERE version=63').run()

    expect(() => dbService.runMigrations()).not.toThrow()
    expect(skillRepo.list().map((s) => ({ id: s.id, category: s.category, tags: s.tags }))).toEqual(before)
  })
})
