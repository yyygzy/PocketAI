// 阶段 3 描述质量面板：过短 / 缺 when-to-use / 高度相似都在详情页如实上屏。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SkillModule } from '../src/renderer/src/modules/skills/SkillModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const skill = (over: Partial<SkillRecord>): SkillRecord => ({
  id: 's1', name: '代码审查', description: '', icon: '🔍', content: '正文',
  enabled: true, resident: true, isBuiltin: false, createdAt: 1,
  ...over
} as SkillRecord)

let skills: SkillRecord[]

beforeEach(() => {
  skills = [skill({ description: '检查代码' })]
  stubPocketai({
    listAssistants: () => [],
    listSkills: () => skills,
    syncSkills: () => ({ count: 0, errors: [] }),
    getSkillTemplates: () => [],
    validateSkill: () => ({ ok: true, warnings: [] }),
    saveSkill: () => skills[0]!,
    deleteSkill: () => ({ ok: true, filesRemoved: false }),
    listSkillFiles: () => ({ ok: true, files: [] }),
    listSkillVersions: () => ({ ok: true, versions: [] }),
    rollbackSkill: () => ({ ok: true, skill: skills[0]! })
  })
})

async function openDetail() {
  mountWithProviders(<SkillModule />)
  fireEvent.click(await screen.findByText('代码审查'))
  await screen.findByTestId('skill-quality-panel')
}

describe('描述质量上屏', () => {
  it('描述过短与缺 when-to-use 都给出建议，但不阻断详情展示', async () => {
    await openDetail()
    expect(screen.getByText(L('skill.qualityTitle'))).toBeTruthy()
    expect(screen.getByText(L('skill.qualityTooShort').replace('{name}', '代码审查'))).toBeTruthy()
    expect(screen.getByText(L('skill.qualityNoWhen').replace('{name}', '代码审查'))).toBeTruthy()
  })

  it('两条高度相似的描述互相指认', async () => {
    const desc = '当需要在提交前审查代码质量、性能与安全隐患时使用这条技能'
    skills = [
      skill({ id: 's1', description: desc }),
      skill({ id: 's2', name: '代码审阅', description: desc })
    ]
    await openDetail()
    expect(screen.getByText(L('skill.qualitySimilar')
      .replace('{name}', '代码审查')
      .replace('{other}', '代码审阅'))).toBeTruthy()
  })

  it('描述合格且没有相似项 ⇒ 显示未发现问题', async () => {
    skills = [skill({ description: '当需要在提交前审查代码质量、性能与安全隐患时使用这条技能' })]
    await openDetail()
    expect(screen.getByText(L('skill.qualityEmpty'))).toBeTruthy()
  })
})
