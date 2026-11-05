// 内置技能残留清理（下线一个内置技能后，DB 里 is_builtin=1 的旧行不能永久残留）
//
// 走真库 + 真 repo + 真同步函数：清理的判定分两半——文件清单（哪些声明还在）与
// 引用面（有没有助手 skillIds 还指着它）。mock 只能钉其中一半，另一半（DELETE/UPDATE 的
// is_builtin 条件）必须落在真 SQL 上，所以这里不用内存假表。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-builtin-skill-cleanup'
  return { dir, data: dir + sep + 'data', db: dir + sep + 'data' + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db, EXTENSIONS_DIR: P.ext }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => P.dir, getPath: () => P.dir }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { syncBuiltinSkills } from '../src/main/assistant/builtin'

const SKILLS_DIR = path.join(P.ext, 'skills')
const file = (id: string): string => path.join(SKILLS_DIR, `${id}.json`)

function writeSkill(id: string, name = id): void {
  fs.writeFileSync(file(id), JSON.stringify({ name, description: `desc ${id}`, icon: '⚡', content: `body ${id}` }))
}
function removeSkillFile(id: string): void {
  fs.rmSync(file(id), { force: true })
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 关不掉不掩盖结论 */ }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch { /* scratch 由临时目录承担 */ }
})

describe('内置技能下线清理', () => {
  it('清单移除后清理生效：未被引用的内置行被删掉，仍在清单里的不受影响', () => {
    writeSkill('keep')
    writeSkill('old')
    const first = syncBuiltinSkills()
    expect(first.count).toBe(2)
    expect(first.removed).toBe(0)
    expect(skillRepo.get('old')).not.toBeNull()

    removeSkillFile('old')
    const second = syncBuiltinSkills()
    expect(second.removed).toBe(1)
    expect(skillRepo.get('old')).toBeNull()
    expect(skillRepo.get('keep')?.isBuiltin).toBe(true)
  })

  it('被助手 skillIds 引用的：保留行与内容、只停用，不静默删也不改写用户配置', () => {
    writeSkill('ref')
    syncBuiltinSkills()
    const a = assistantRepo.save({ name: '引用者', skillIds: ['ref'] })

    removeSkillFile('ref')
    const out = syncBuiltinSkills()
    expect(out.removed).toBe(0)
    expect(out.retired).toBe(1)

    const kept = skillRepo.get('ref')
    expect(kept).not.toBeNull()
    expect(kept!.content).toBe('body ref')
    expect(kept!.enabled).toBe(false)
    // 助手那侧的引用原样保留（这里是"保留但停用"，不是"解除引用"）
    expect(assistantRepo.get(a.id)?.skillIds).toEqual(['ref'])
  })

  it('用户导入/自建的技能不受影响（清理只看 is_builtin=1 的行）', () => {
    const mine = skillRepo.save({ name: '我的技能', content: 'user content' })
    expect(mine.isBuiltin).toBe(false)
    const out = syncBuiltinSkills()
    expect(out.removed).toBe(0)
    expect(skillRepo.get(mine.id)?.isBuiltin).toBe(false)
    expect(skillRepo.get(mine.id)?.content).toBe('user content')
    // 清理的候选面里根本没有它
    expect(skillRepo.listBuiltinIds()).not.toContain(mine.id)
  })

  it('二次启动幂等：已删的不再出现，已停用的不重复计数', () => {
    const a = syncBuiltinSkills()
    expect(a.removed).toBe(0)
    expect(a.retired).toBe(0)
    const b = syncBuiltinSkills()
    expect(b.removed).toBe(0)
    expect(b.retired).toBe(0)
    expect(skillRepo.get('old')).toBeNull()
    expect(skillRepo.get('ref')?.enabled).toBe(false)
  })

  it('文件还在但解析失败：只报错、不当作"已下线"清理', () => {
    writeSkill('bad')
    syncBuiltinSkills()
    expect(skillRepo.get('bad')).not.toBeNull()

    fs.writeFileSync(file('bad'), '{ broken json')
    const out = syncBuiltinSkills()
    expect(out.errors.length).toBeGreaterThan(0)
    expect(out.removed).toBe(0)
    expect(skillRepo.get('bad')).not.toBeNull()
  })

  it('清单目录整体读不到时一行都不清（读不到 ≠ 全部下线）', () => {
    fs.rmSync(SKILLS_DIR, { recursive: true, force: true })
    const out = syncBuiltinSkills()
    expect(out.removed).toBe(0)
    expect(out.retired).toBe(0)
    expect(skillRepo.get('keep')).not.toBeNull()
    expect(skillRepo.get('ref')).not.toBeNull()
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
  })
})
