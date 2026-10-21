// @vitest-environment node
// §236 `load_skill` 这颗工具：真读文件（临时 DATA_DIR），判据是"这次运行绑了哪些技能"。
//
// 这条链上最容易出错的两件事都被单独钉住：
//  · **越权读**：没绑定给这次运行的技能，名字对上也不给读（工具不是"看库里所有技能"的口子）；
//  · **路径逃逸**：path 交给 skill-files 那一层（真软链与跳出目录在 skill-files-236 里验，这里验接线）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 与仓内其它真临时目录用例同一写法（base 用 indexOf 判断平台分隔符）
const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/'
  return base + sep + 'pocketai-skill-tool-236'
})

vi.mock('../src/main/portable', async () => {
  const p = await import('node:path')
  return {
    DATA_DIR: p.join(TMP, 'data'),
    DB_PATH: '',
    MCP_EXTENSIONS_DIR: '',
    isPortable: () => false,
    portableDataDir: () => TMP
  }
})

const { bound } = vi.hoisted(() => ({ bound: { skills: [] as unknown[] } }))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: {
    listEnabledByIds: (ids: string[]) =>
      (bound.skills as Array<{ id: string; enabled: boolean }>).filter(
        (s) => s.enabled && ids.includes(s.id)
      )
  }
}))

import { getSkillTools } from '../src/main/tools/skill-tools'
import { installSkillFiles } from '../src/main/skills/skill-files'
import type { SkillRecord } from '../src/shared/types'

const tool = getSkillTools()[0]!

const rec = (over: Partial<SkillRecord>): SkillRecord =>
  ({
    id: 's1',
    name: '翻译助手',
    description: '专业翻译',
    icon: '🌐',
    content: '翻译时忠实原文。',
    enabled: true,
    resident: false,
    isBuiltin: false,
    createdAt: 1,
    ...over
  }) as SkillRecord

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

const SKILL_WITH_FILES = 's-with-files'

describe('取正文与取文件', () => {
  it('按名字命中 ⇒ 回正文，并附上它自带的文件清单（第三层的入口）', async () => {
    bound.skills = [rec({ id: SKILL_WITH_FILES, name: '检索技能', content: '入口正文' })]
    const src = path.join(TMP, 'src2')
    fs.mkdirSync(path.join(src, 'references'), { recursive: true })
    fs.writeFileSync(path.join(src, 'SKILL.md'), '入口正文', 'utf8')
    fs.writeFileSync(path.join(src, 'references', 'api.md'), 'API 说明在此', 'utf8')
    const read = (await import('../src/main/skills/skill-files')).readSkillFolder(src)
    installSkillFiles(SKILL_WITH_FILES, read.files)

    const out = JSON.parse(await tool.execute({ skill: '检索技能' }, { skillIds: [SKILL_WITH_FILES] }))
    expect(out.content).toBe('入口正文')
    expect(out.files.map((f: { path: string }) => f.path)).toEqual(['references/api.md'])

    const file = JSON.parse(
      await tool.execute({ skill: SKILL_WITH_FILES, path: 'references/api.md' }, { skillIds: [SKILL_WITH_FILES] })
    )
    expect(file.content).toBe('API 说明在此')
    expect(file.truncated).toBe(false)
  })
})

describe('四条不许放宽的边界', () => {
  it('这次运行没绑技能 ⇒ 一颗都读不到（不是"读所有技能"的口子）', async () => {
    bound.skills = [rec({})]
    await expect(tool.execute({ skill: '翻译助手' }, {})).rejects.toThrow(/没有绑定任何技能/)
  })

  it('名字对了但没绑定给这次运行 ⇒ 同样拒，并把可用的清单报回去（让模型下一步能自己纠正）', async () => {
    bound.skills = [rec({ id: 's1', name: '翻译助手' }), rec({ id: 's2', name: '代码审查' })]
    await expect(tool.execute({ skill: '翻译助手' }, { skillIds: ['s2'] })).rejects.toThrow(/代码审查/)
  })

  it('同名两条 ⇒ 拒，并提示改传 id（不赌一条）', async () => {
    bound.skills = [rec({ id: 'aaa1', name: '重名' }), rec({ id: 'bbb2', name: '重名' })]
    await expect(tool.execute({ skill: '重名' }, { skillIds: ['aaa1', 'bbb2'] })).rejects.toThrow(/请改传 id/)
  })

  it('path 越界 ⇒ 拒（那一层的判据在这里也走得到）', async () => {
    bound.skills = [rec({ id: 's9', name: '有文件的' })]
    await expect(
      tool.execute({ skill: 's9', path: '../../outside.txt' }, { skillIds: ['s9'] })
    ).rejects.toThrow()
  })

  it('禁用中的技能读不到（与注入那一档同一条口径：enabled=false 就不该出现）', async () => {
    bound.skills = [rec({ id: 's10', name: '停用的', enabled: false })]
    await expect(tool.execute({ skill: '停用的' }, { skillIds: ['s10'] })).rejects.toThrow()
  })
})

describe('这颗工具的形状', () => {
  it('id/name/permission 固定：auto ⇒ 与 `*`（只给内置）那条语义天然同源，子级工具面也照得住', () => {
    expect(tool.schema.id).toBe('skill.load')
    expect(tool.schema.name).toBe('load_skill')
    expect(tool.schema.permission).toBe('auto')
    expect(tool.schema.source).toBe('builtin')
    expect(Object.keys(tool.schema.parameters as object)).toContain('required')
  })
})
