// 技能升级阶段 1（v80）真库验收：版本/来源/内容哈希落库、同来源更新、版本历史与回滚。
// 只替日志与路径，迁移与仓储全真。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-skill-v80'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { computeSkillChecksum } from '../src/main/skills/skill-package'

const URL = 'https://example.com/skills/review/SKILL.md'

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try { dbService.close() } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

function columns(table: string): string[] {
  return (dbService.getHandle().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

describe('v80 迁移与老库兼容', () => {
  it('skills 增加治理列、skill_versions 表与索引建成，老技能读出空值/0', () => {
    expect(columns('skills')).toEqual(expect.arrayContaining([
      'version', 'author', 'license', 'source_url', 'source_commit', 'content_hash', 'installed_at'
    ]))
    expect(dbService.getHandle().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_versions'").get()).toBeTruthy()
    expect(dbService.getHandle().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_skill_versions_skill_at'").get()).toBeTruthy()

    dbService.getHandle().prepare(
      `INSERT INTO skills (id, name, description, icon, content, enabled, is_builtin, created_at)
       VALUES ('legacy', '老技能', '', '⚡', '老正文', 1, 0, 1)`
    ).run()
    const legacy = skillRepo.get('legacy')!
    expect(legacy.version).toBe('')
    expect(legacy.sourceUrl).toBe('')
    expect(legacy.installedAt).toBe(0)
  })
})

describe('同来源导入 = 更新同一条，而不是造副本', () => {
  it('第二次同来源保存复用 id、内容更新、旧版进历史', () => {
    const first = skillRepo.save({
      name: '代码审查', description: 'v1', icon: '🔍', content: 'v1 正文',
      version: '1.0.0', author: 'Alice', license: 'MIT',
      sourceUrl: URL, sourceCommit: 'abc123',
      contentHash: 'hash-v1', installedAt: 1_000
    })
    expect(first.id).toBeTruthy()

    const second = skillRepo.save({
      name: '代码审查', description: 'v2', icon: '🔍', content: 'v2 正文',
      version: '2.0.0', author: 'Alice', license: 'MIT',
      sourceUrl: URL, sourceCommit: 'def456',
      contentHash: 'hash-v2', installedAt: 2_000
    })
    expect(second.id).toBe(first.id)
    expect(second.content).toBe('v2 正文')
    expect(second.version).toBe('2.0.0')
    expect(second.sourceCommit).toBe('def456')

    const versions = skillRepo.listVersions(first.id)
    expect(versions.length).toBeGreaterThanOrEqual(1)
    // 快照在更新之前写，所以第一条历史是 v1
    expect(versions[0]!.content).toBe('v1 正文')
    expect(versions[0]!.version).toBe('1.0.0')
  })

  it('无来源的手工技能按原行为新建 UUID，不误复用', () => {
    const a = skillRepo.save({ name: '手工甲', content: 'A' })
    const b = skillRepo.save({ name: '手工乙', content: 'B' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('版本历史与回滚', () => {
  it('回滚恢复正文与元数据，但不改启停/常驻偏好', () => {
    const skill = skillRepo.save({
      name: '回滚测试', content: '新版正文', version: '3.0.0', sourceUrl: `${URL}#rollback`,
      contentHash: 'hash-v3', installedAt: 3_000, resident: false, enabled: false
    })
    skillRepo.snapshotVersion({ ...skill, content: '旧版正文', version: '2.9.0' }, 5)
    const versions = skillRepo.listVersions(skill.id)
    const target = versions.find((v) => v.content === '旧版正文')!
    expect(target).toBeTruthy()

    const after = skillRepo.rollbackTo(skill.id, target.id)!
    expect(after.content).toBe('旧版正文')
    expect(after.version).toBe('2.9.0')
    expect(after.enabled).toBe(false)
    expect(after.resident).toBe(false)
  })

  it('历史只保留最近 N 版', () => {
    const skill = skillRepo.save({ name: '裁剪测试', content: 'base', sourceUrl: `${URL}#keep` })
    for (let i = 0; i < 8; i++) {
      skillRepo.snapshotVersion({ ...skill, content: `v${i}`, installedAt: i + 1 }, 3)
    }
    expect(skillRepo.listVersions(skill.id)).toHaveLength(3)
  })

  it('回滚到不属于该技能的版本 id ⇒ 返回 null，不改数据', () => {
    const a = skillRepo.save({ name: 'A', content: 'A 正文' })
    const b = skillRepo.save({ name: 'B', content: 'B 正文' })
    skillRepo.snapshotVersion(b)
    const foreign = skillRepo.listVersions(b.id)[0]!
    expect(skillRepo.rollbackTo(a.id, foreign.id)).toBeNull()
    expect(skillRepo.get(a.id)!.content).toBe('A 正文')
  })
})

describe('内容哈希口径', () => {
  it('复用 skill-package 校验和：同字段恒定、字段变则变', () => {
    const fields = { name: 'n', description: 'd', icon: 'x', content: 'c', category: '', tags: [] }
    expect(computeSkillChecksum(fields).value).toBe(computeSkillChecksum(fields).value)
    expect(computeSkillChecksum(fields).value).not.toBe(computeSkillChecksum({ ...fields, content: 'c2' }).value)
  })
})
