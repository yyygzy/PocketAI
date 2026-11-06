// V4-Iter-428 第二步：内置助手技能绑定（json + 迁移 v56）
//
// 现场：技能"启用即空转"的另一半——内置助手永远拿不到技能。市场那颗「启用」只写
// `skills.enabled`，运行期却按助手的 `skillIds` 取（∩ enabled）。这一版把用户已拍板的 10 条绑定
// 落到两处：**新装机**靠 `extensions/assistants/*.json` 首次插入；**老库**靠迁移 v56 给
// 已存在的内置行补并集（不覆盖、不动 enabled、不碰"我的助手"）。
//
// 钉住四件事：
//  ① json 与迁移常量逐条一致（两份数据不许漂）；
//  ② 真库迁移：空行 / 已有内容 / 用户副本三种现场，连跑两次幂等；
//  ③ 运行期：绑定后上下文真的出现该技能，没绑的助手不出现；
//  ④ 用户停用过的技能即使被绑定也不生效（listEnabledByIds 还要 enabled=1）。
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-builtin-bindings'
  // 这个 mock 工厂在 import 之前求值，拿不到测试文件里的 __dirname；vitest 的 cwd 就是仓库根
  const ext = process.cwd() + sep + 'extensions'
  return { dir, db: dir + sep + 'app.db', ext }
})
vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  EXTENSIONS_DIR: P.ext
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { syncBuiltinAssistants, syncBuiltinSkills } from '../src/main/assistant/builtin'
import { buildSkillsContextResult } from '../src/main/assistant/skills'
import { BUILTIN_ASSISTANT_SKILL_IDS } from '../src/main/db/builtin-assistant-skills'

const ASSISTANT_FILES = [
  'asst-academic', 'asst-analyst', 'asst-coder', 'asst-default',
  'asst-pm', 'asst-translator', 'asst-tutor', 'asst-writer'
]

function jsonSkillIds(id: string): string[] {
  const raw = fs.readFileSync(path.join(P.ext, 'assistants', `${id}.json`), 'utf8')
  return (JSON.parse(raw) as { skillIds?: string[] }).skillIds ?? []
}

function skillIdsOf(assistantId: string): string[] {
  return assistantRepo.get(assistantId)?.skillIds ?? []
}

/** 重建一个空库（表结构 + 全部迁移都已应用） */
function resetDb(): void {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
}

/** 退回 v56 的记录，让下一次 runMigrations 真的重跑那条迁移 */
function rewindV56(): void {
  dbService.getHandle().prepare('DELETE FROM schema_migrations WHERE version = 56').run()
}

beforeEach(() => {
  resetDb()
})

afterAll(() => {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('① json 与迁移常量同一份数据', () => {
  it('8 份 json 的 skillIds 与 BUILTIN_ASSISTANT_SKILL_IDS 逐条相等（含顺序）', () => {
    expect(Object.keys(BUILTIN_ASSISTANT_SKILL_IDS).sort()).toEqual([...ASSISTANT_FILES].sort())
    for (const id of ASSISTANT_FILES) {
      expect(jsonSkillIds(id), `${id}.json 与迁移常量漂了`).toEqual([...BUILTIN_ASSISTANT_SKILL_IDS[id]!])
    }
  })

  it('通用问答保持空、两条不绑的技能没有任何内置助手引用', () => {
    expect(jsonSkillIds('asst-default')).toEqual([])
    const all = ASSISTANT_FILES.flatMap((id) => jsonSkillIds(id))
    expect(all).not.toContain('skill-concise')
    expect(all).not.toContain('skill-prompt-engineer')
    for (const id of ASSISTANT_FILES) {
      const ids = jsonSkillIds(id)
      expect(new Set(ids).size, `${id} 同一条技能绑了两次`).toBe(ids.length)
    }
  })

  it('绑定的 id 都是仓库里真实存在的内置技能', () => {
    const skillFiles = new Set(
      fs.readdirSync(path.join(P.ext, 'skills')).map((f) => path.basename(f, path.extname(f)))
    )
    for (const id of ASSISTANT_FILES) {
      for (const skillId of jsonSkillIds(id)) {
        expect(skillFiles.has(skillId), `${id} 绑了不存在的技能 ${skillId}`).toBe(true)
      }
    }
  })
})

describe('② 迁移 v56：只补已存在的内置行、并集、幂等', () => {
  it('全新库：迁移时没有内置行也不抛；随后文件同步按 json 插入绑定', () => {
    rewindV56()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(assistantRepo.list().length, '全新库此时还没有助手行').toBe(0)

    const r = syncBuiltinAssistants()
    expect(r.errors).toEqual([])
    for (const id of ASSISTANT_FILES) {
      expect(skillIdsOf(id), `${id} 首插就该带上 json 绑定`).toEqual(jsonSkillIds(id))
    }
    expect(skillIdsOf('asst-default')).toEqual([])
  })

  it('老库空绑定：v56 补成映射里的并集', () => {
    dbService.getHandle()
      .prepare(`INSERT INTO assistants (id, name, skill_ids, is_builtin, is_pinned, created_at)
                VALUES ('asst-coder', '代码工程师', '[]', 1, 1, 1)`)
      .run()
    rewindV56()
    dbService.runMigrations()
    expect(skillIdsOf('asst-coder')).toEqual([...BUILTIN_ASSISTANT_SKILL_IDS['asst-coder']!])
  })

  it('老库已有内容：只做并集，原有 id（用户/历史）原顺序保留、不被覆盖', () => {
    dbService.getHandle()
      .prepare(`INSERT INTO assistants (id, name, skill_ids, is_builtin, is_pinned, created_at)
                VALUES ('asst-coder', '代码工程师', '["skill-concise"]', 1, 1, 1)`)
      .run()
    rewindV56()
    dbService.runMigrations()
    expect(skillIdsOf('asst-coder')).toEqual([
      'skill-concise',
      'skill-bug-diagnostician',
      'skill-code-review'
    ])
  })

  it('幂等：退回记录连跑两次，结果相同且无重复', () => {
    dbService.getHandle()
      .prepare(`INSERT INTO assistants (id, name, skill_ids, is_builtin, is_pinned, created_at)
                VALUES ('asst-writer', '写作润色', '[]', 1, 0, 1)`)
      .run()
    rewindV56()
    dbService.runMigrations()
    const once = skillIdsOf('asst-writer')

    rewindV56()
    dbService.runMigrations()
    expect(skillIdsOf('asst-writer')).toEqual(once)
    expect(new Set(once).size).toBe(once.length)
  })

  it('"我的助手"（用户复制出的副本）与用户手工内容一概不动', () => {
    dbService.getHandle()
      .prepare(`INSERT INTO assistants (id, name, skill_ids, is_builtin, is_pinned, created_at)
                VALUES ('mine-copy', '代码工程师（副本）', '["skill-writer"]', 0, 0, 1)`)
      .run()
    rewindV56()
    dbService.runMigrations()
    expect(skillIdsOf('mine-copy')).toEqual(['skill-writer'])
    // 迁移只认内置 id，非内置那条连条件都匹配不上
    expect(assistantRepo.mergeBuiltinSkillIds('mine-copy', ['skill-code-review'])).toBe(0)
    expect(skillIdsOf('mine-copy')).toEqual(['skill-writer'])
  })

  it('受限写方法：只写 skill_ids、重复调用返回 0、不改其它列', () => {
    syncBuiltinAssistants()
    const before = assistantRepo.get('asst-coder')!
    const added = assistantRepo.mergeBuiltinSkillIds('asst-coder', ['skill-concise'])
    expect(added, '并集应该只多出 1 条').toBe(1)
    const after = assistantRepo.get('asst-coder')!
    expect(after.skillIds).toContain('skill-concise')
    expect(after.name).toBe(before.name)
    expect(after.systemPrompt).toBe(before.systemPrompt)
    expect(after.toolPermissions).toEqual(before.toolPermissions)
    expect(assistantRepo.mergeBuiltinSkillIds('asst-coder', ['skill-concise'])).toBe(0)
  })
})

describe('③④ 运行期：绑定才进上下文，停用的绑了也不生效', () => {
  it('绑定后上下文出现该技能；未绑定的助手（通用问答）不出现', () => {
    syncBuiltinAssistants()
    const r = syncBuiltinSkills()
    expect(r.errors).toEqual([])

    const coder = buildSkillsContextResult(skillIdsOf('asst-coder'))
    const bug = skillRepo.get('skill-bug-diagnostician')!
    const review = skillRepo.get('skill-code-review')!
    expect(coder.text, '绑定的两条都该进上下文').toContain(bug.content.trim())
    expect(coder.text).toContain(review.content.trim())

    const def = buildSkillsContextResult(skillIdsOf('asst-default'))
    expect(def.text, '通用问答没绑任何技能').toBe('')
    expect(def.text).not.toContain(bug.content.trim())
  })

  it('用户停用过的技能：迁移/绑定保留在 skill_ids 里，但运行期上下文不注入', () => {
    syncBuiltinAssistants()
    syncBuiltinSkills()
    skillRepo.save({ id: 'skill-code-review', name: '代码审查', enabled: false })
    expect(skillRepo.get('skill-code-review')!.enabled).toBe(false)
    expect(skillIdsOf('asst-coder'), '绑定是惰性的：id 还在').toContain('skill-code-review')

    const ctx = buildSkillsContextResult(skillIdsOf('asst-coder'))
    const review = skillRepo.get('skill-code-review')!
    expect(ctx.text, '停用的技能绑了也不许进上下文').not.toContain(review.content.trim())
    expect(ctx.text).toContain(skillRepo.get('skill-bug-diagnostician')!.content.trim())
  })
})
