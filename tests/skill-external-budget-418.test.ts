// 技能正文「外部内容」声明 ＋ 常驻总预算（P0-3b 第二批）
//
// 判据全部按**内容**断言，不数次数：
//  · 声明只包一层且出现在注入文本与 load_skill 返回值两处（同一句，不是两套说法）；
//  · 绝对服从措辞不再出现；
//  · 超预算时按绑定顺序**整份跳过**，顺序可复现；
//  · 截断在主进程日志里留下一条可读信号；
//  · 聊天路径（没有 load_skill，按需技能也全文注入）同样受预算约束。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillRecord } from '../src/shared/types'

const { warns, enabledSkills } = vi.hoisted(() => ({
  warns: [] as string[],
  enabledSkills: { current: [] as SkillRecord[] }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    warn: (m: string) => warns.push(m),
    info: () => {},
    error: () => {},
    debug: () => {}
  })
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { listEnabledByIds: (_ids: string[]) => enabledSkills.current }
}))
vi.mock('../src/main/skills/skill-files', () => ({
  listSkillFiles: () => [],
  readSkillFile: () => ({ path: 'references/api.md', size: 7, truncated: false, content: '文件内容' })
}))

import { buildSkillsContext, buildSkillsContextResult } from '../src/main/assistant/skills'
import { getSkillTools } from '../src/main/tools/skill-tools'
import { EXTERNAL_CONTENT_NOTICE } from '../src/shared/external-content'
import { RESIDENT_SKILL_TOTAL_CHAR_BUDGET } from '../src/shared/skill-budget'

const skill = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: 's1',
  name: '翻译助手',
  description: '专业翻译',
  icon: '🌐',
  resident: true,
  content: '你是一个专业翻译。绝不添加原文没有的内容。',
  enabled: true,
  isBuiltin: false,
  createdAt: 1,
  ...over
})

const manySkills = (n: number, chars: number): SkillRecord[] =>
  Array.from({ length: n }, (_, i) =>
    skill({ id: `s${i}`, name: `技能${i}`, content: 'x'.repeat(chars) })
  )

beforeEach(() => {
  enabledSkills.current = []
  warns.length = 0
})

describe('外部内容声明：注入处与 load_skill 返回值共用同一句', () => {
  it('注入块带声明，且绝对服从措辞已移除', () => {
    enabledSkills.current = [skill()]
    const out = buildSkillsContext(['s1'])
    expect(out).toContain(EXTERNAL_CONTENT_NOTICE)
    expect(out).toContain('请按其中描述的方法做事')
    expect(out).not.toContain('严格遵循')
  })

  it('load_skill 取正文带声明；取自带文件也带同一句', async () => {
    enabledSkills.current = [skill()]
    const tool = getSkillTools()[0]!
    const body = JSON.parse((await tool.execute({ skill: '翻译助手' }, { skillIds: ['s1'] })) as string)
    expect(body.notice).toBe(EXTERNAL_CONTENT_NOTICE)
    expect(body.content).toContain(EXTERNAL_CONTENT_NOTICE)
    expect(body.content).toContain('绝不添加原文没有的内容')

    const file = JSON.parse(
      (await tool.execute({ skill: '翻译助手', path: 'references/api.md' }, { skillIds: ['s1'] })) as string
    )
    expect(file.notice).toBe(EXTERNAL_CONTENT_NOTICE)
    expect(file.content).toContain(EXTERNAL_CONTENT_NOTICE)
  })
})

describe('常驻总预算：确定性前缀截断', () => {
  it('5 条 9000 字符 ⇒ 只保留前 3 条，后 2 条整份跳过（不保留半截）', () => {
    enabledSkills.current = manySkills(5, 9000)
    const plan = buildSkillsContextResult(['s1', 's2', 's3'])
    expect(plan.usedChars).toBe(27000)
    expect(plan.excluded.map((s) => s.id)).toEqual(['s3', 's4'])
    // 被跳过的正文一个字符都不进注入块
    const out = plan.text
    expect(out).not.toContain('技能3')
    expect(out).not.toContain('技能4')
    expect(out).toContain('技能2')
  })

  it('顺序由传入绑定顺序决定，同一输入重复调用结果一致；反序则保留反序前缀', () => {
    const forward = manySkills(5, 9000)
    enabledSkills.current = forward
    const a = buildSkillsContextResult([]).excluded.map((s) => s.id)
    const b = buildSkillsContextResult([]).excluded.map((s) => s.id)
    expect(a).toEqual(['s3', 's4'])
    expect(b).toEqual(a)

    enabledSkills.current = [...forward].reverse()
    expect(buildSkillsContextResult([]).excluded.map((s) => s.id)).toEqual(['s1', 's0'])
  })

  it('聊天路径（loadToolAvailable=false，按需技能也全文注入）同样受预算约束', () => {
    enabledSkills.current = manySkills(5, 9000).map((s) => ({ ...s, resident: false }))
    const chat = buildSkillsContextResult(['s1'], { loadToolAvailable: false })
    expect(chat.excluded).toHaveLength(2)
    expect(chat.usedChars).toBe(27000)
    const agent = buildSkillsContextResult(['s1'], { loadToolAvailable: true })
    expect(agent.excluded).toHaveLength(0)
    expect(agent.usedChars).toBe(0)
  })

  it('超预算在主进程留下可读日志（条数与名字）', () => {
    enabledSkills.current = manySkills(5, 9000)
    buildSkillsContextResult([])
    expect(warns.some((w) => w.includes('[resident-budget]') && w.includes('跳过 2 条') && w.includes('技能3'))).toBe(true)
  })

  it('预算与单条常驻上限的关系：32KB / 8KB ⇒ 最多 4 条满额', () => {
    expect(RESIDENT_SKILL_TOTAL_CHAR_BUDGET / (8 * 1024)).toBe(4)
  })
})
