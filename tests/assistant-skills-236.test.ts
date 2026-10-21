// @vitest-environment node
// §236 注入形状：常驻／按需两档，以及"按需只有在模型真拿得到 load_skill 时才成立"那条口径。
//
// 三条判据不是装饰：
//  · 全常驻时的输出**逐字等于改动前**——这条是回归基线，挡住"顺手重构把老用户的行为改了"；
//  · 按需档下正文一个字节都不许在块里（判据②的形状面；token 数字在台账里另测）；
//  · 工具不在面上时不许走按需档——那等于给用户一句模型执行不了的指令（§222 那一族的"别说不可能做到的话"）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillRecord } from '../src/shared/types'

const { enabledSkills } = vi.hoisted(() => ({
  enabledSkills: { current: [] as SkillRecord[] }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { listEnabledByIds: (_ids: string[]) => enabledSkills.current }
}))

import { buildSkillsContext } from '../src/main/assistant/skills'

const skill = (over: Partial<SkillRecord>): SkillRecord =>
  ({
    id: 's1',
    name: '翻译助手',
    description: '专业翻译',
    icon: '🌐',
    content: '你是一个专业翻译。绝不添加原文没有的内容。',
    enabled: true,
    resident: true,
    isBuiltin: false,
    createdAt: 1,
    ...over
  }) as SkillRecord

beforeEach(() => {
  enabledSkills.current = []
})

describe('常驻档：与改动前逐字相同', () => {
  it('两条常驻技能 ⇒ 输出与改动前那版实现逐字相同（回归基线，不是"看起来差不多"）', () => {
    enabledSkills.current = [skill({}), skill({ id: 's2', name: '代码审查', content: '审查代码' })]
    const out = buildSkillsContext(['s1', 's2'])
    // 这条期望串是按 V4-Iter-236 之前 `buildSkillsContext`/`formatSkill` 的输出**手抄的原件**：
    // '## 已启用技能\n\n' + 头一句 + '\n\n' + 各条 '### {icon} {name}\n（{description}）\n{content}'，两条之间 '\n\n'
    const expected =
      '## 已启用技能\n\n以下是当前助手启用的技能指令，请在回答中严格遵循：\n\n' +
      '### 🌐 翻译助手\n（专业翻译）\n你是一个专业翻译。绝不添加原文没有的内容。\n\n' +
      '### 🌐 代码审查\n（专业翻译）\n审查代码'
    expect(out).toBe(expected)
    expect(out).not.toContain('load_skill')
  })
})

describe('按需档：正文不在块里，但名字、用途与取法都在', () => {
  it('resident=false 且工具可用 ⇒ 只留一行元数据，正文一个字节都不出现', () => {
    enabledSkills.current = [skill({ resident: false })]
    const out = buildSkillsContext(['s1'], { loadToolAvailable: true })
    expect(out).not.toContain('绝不添加原文没有的内容')
    expect(out).toContain('翻译助手')
    expect(out).toContain('专业翻译')
    expect(out).toContain('load_skill')
  })

  it('混合两条 ⇒ 两段都在，各说各的（不是"有一棵按需就把全部收起"）', () => {
    enabledSkills.current = [
      skill({}),
      skill({ id: 's2', name: '长文检索', description: '查资料', content: '这份正文很长不该每次带', resident: false })
    ]
    const out = buildSkillsContext(['s1', 's2'], { loadToolAvailable: true })
    expect(out).toContain('绝不添加原文没有的内容')
    expect(out).not.toContain('这份正文很长不该每次带')
    expect(out).toContain('长文检索')
  })

  it('反向对照（这条最要紧）：工具不在这次面上时，resident=false 的技能也照旧全文注入', () => {
    enabledSkills.current = [skill({ resident: false })]
    const noTool = buildSkillsContext(['s1'], { loadToolAvailable: false })
    expect(noTool).toContain('绝不添加原文没有的内容')
    expect(noTool).not.toContain('要用它时先调')
    // 缺省参数也是这一档：普通聊天那条调用链没有工具
    expect(buildSkillsContext(['s1'])).toContain('绝不添加原文没有的内容')
  })

  it('没有启用技能 ⇒ 空串（不产出一段空头标题）', () => {
    expect(buildSkillsContext([], { loadToolAvailable: true })).toBe('')
  })
})
