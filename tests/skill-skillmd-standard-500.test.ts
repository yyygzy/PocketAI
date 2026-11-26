// 技能升级阶段 2 真库验收：标准 SKILL.md 样例 → 元数据落库；超长正文只给软提示不阻断。
// 只替日志与路径，迁移、解析、仓储全真。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-skill-standard-500'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { parseSkillText } from '../src/main/skills/skill-parser'
import { saveShapeAsSkill } from '../src/main/skills/skill-io'
import { scanSkill } from '../src/main/skills/skill-scan'

const SOURCE_URL = 'https://example.com/skills/code-review/SKILL.md'

const STANDARD_SKILL_MD = `---
name: 代码审查
description: 审查代码质量与安全性
version: 1.2.0
license: MIT
metadata:
  author: Upstream Author
---
审查时先读代码，再给出问题清单。
`

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

describe('标准 SKILL.md 导入', () => {
  it('version/author/license/来源/commit/哈希/安装时间都落到库里', () => {
    const parsed = parseSkillText(STANDARD_SKILL_MD)
    expect(parsed.error).toBe('')
    expect(parsed.shape).toBeTruthy()
    expect(parsed.ignoredKeys).not.toContain('metadata')

    const saved = saveShapeAsSkill(parsed.shape!, { sourceUrl: SOURCE_URL, sourceCommit: 'rev-1' })
    const row = skillRepo.get(saved.id)!
    expect(row.version).toBe('1.2.0')
    expect(row.author).toBe('Upstream Author')
    expect(row.license).toBe('MIT')
    expect(row.sourceUrl).toBe(SOURCE_URL)
    expect(row.sourceCommit).toBe('rev-1')
    expect(row.contentHash).toBeTruthy()
    expect(row.installedAt).toBeGreaterThan(0)
  })

  it('kebab-case 来源 URL 作为身份键，重复导入仍更新同一条', () => {
    const first = saveShapeAsSkill(parseSkillText(STANDARD_SKILL_MD).shape!, { sourceUrl: SOURCE_URL })
    const second = saveShapeAsSkill(
      parseSkillText(STANDARD_SKILL_MD.replace('1.2.0', '1.3.0')).shape!,
      { sourceUrl: SOURCE_URL }
    )
    expect(second.id).toBe(first.id)
    expect(skillRepo.get(second.id)!.version).toBe('1.3.0')
    expect(skillRepo.listVersions(second.id).length).toBeGreaterThanOrEqual(1)
  })
})

describe('超长正文软提示', () => {
  it('501 行正文扫出拆分建议，但导入照常落库', () => {
    const longBody = Array.from({ length: 501 }, (_, i) => `line-${i}`).join('\n')
    const md = `---
name: 长正文技能
description: 演示拆分建议
version: 1.0.0
---
${longBody}
`
    const parsed = parseSkillText(md)
    expect(parsed.error).toBe('')

    const scan = scanSkill({ content: parsed.shape!.content })
    expect(scan.findings.map((f) => f.code)).toContain('LONG_BODY_SPLIT_HINT')
    expect(scan.level).toBe('info')

    const saved = saveShapeAsSkill(parsed.shape!, { sourceUrl: `${SOURCE_URL}#long` })
    expect(skillRepo.get(saved.id)!.content).toBe(parsed.shape!.content)
  })
})
