// assistant/skills 技能上下文构建测试
//
// 覆盖 src/main/assistant/skills.ts 的两个函数：
//   - formatSkill：SkillRecord → 提示词片段（含可选描述、content trim）
//   - buildSkillsContext：按 skillIds 拉取启用技能，拼接注入块
//
// 策略：mock skillRepo.listEnabledByIds 返回受控技能列表；formatSkill 纯函数直接断言。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillRecord } from '../src/shared/types'

const { enabledSkills } = vi.hoisted(() => ({
  enabledSkills: { current: [] as SkillRecord[] }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: {
    listEnabledByIds: (_ids: string[]) => enabledSkills.current
  }
}))

import { formatSkill, buildSkillsContext } from '../src/main/assistant/skills'

beforeEach(() => {
  enabledSkills.current = []
})

const baseSkill = (over: Partial<SkillRecord> = {}): SkillRecord => ({
  id: 's1',
  name: '翻译助手',
  description: '专业翻译',
  icon: '🌐',
  content: '你是一个翻译助手',
  enabled: true,
  isBuiltin: false,
  createdAt: 100,
  ...over
})

describe('formatSkill — 格式化单个技能为提示词片段', () => {
  it('含描述 → 输出 icon + name + 描述行 + content', () => {
    const s = baseSkill()
    expect(formatSkill(s)).toBe('### 🌐 翻译助手\n（专业翻译）\n你是一个翻译助手')
  })

  it('无描述 → 不输出描述行', () => {
    const s = baseSkill({ description: '' })
    expect(formatSkill(s)).toBe('### 🌐 翻译助手\n你是一个翻译助手')
  })

  it('content 首尾空白 → trim', () => {
    const s = baseSkill({ content: '  \n  你是一个翻译助手  \n  ' })
    expect(formatSkill(s)).toBe('### 🌐 翻译助手\n（专业翻译）\n你是一个翻译助手')
  })

  it('icon 为 emoji，原样保留', () => {
    const s = baseSkill({ icon: '⚡', name: '代码助手', description: '' })
    expect(formatSkill(s)).toBe('### ⚡ 代码助手\n你是一个翻译助手')
  })
})

describe('buildSkillsContext — 构建技能注入块', () => {
  it('无启用技能 → 空串', () => {
    expect(buildSkillsContext(['s1'])).toBe('')
  })

  it('单个技能 → 注入块 + 单个技能片段', () => {
    enabledSkills.current = [baseSkill()]
    const result = buildSkillsContext(['s1'])
    expect(result).toBe(
      '## 已启用技能\n\n以下是当前助手启用的技能指令，请在回答中严格遵循：\n\n### 🌐 翻译助手\n（专业翻译）\n你是一个翻译助手'
    )
  })

  it('多个技能 → 用空行分隔', () => {
    enabledSkills.current = [
      baseSkill({ id: 's1', name: 'A', description: '' }),
      baseSkill({ id: 's2', name: 'B', description: '' })
    ]
    const result = buildSkillsContext(['s1', 's2'])
    const parts = result.split('\n\n')
    // 最后两段是两个技能片段
    expect(parts[parts.length - 1]).toBe('### 🌐 B\n你是一个翻译助手')
    expect(parts[parts.length - 2]).toBe('### 🌐 A\n你是一个翻译助手')
  })

  it('空 skillIds → 仍走 listEnabledByIds([])，无技能返回空串', () => {
    expect(buildSkillsContext([])).toBe('')
  })

  it('注入块头部固定文案', () => {
    enabledSkills.current = [baseSkill()]
    const result = buildSkillsContext(['s1'])
    expect(result.startsWith('## 已启用技能\n\n以下是当前助手启用的技能指令，请在回答中严格遵循：\n\n')).toBe(true)
  })
})
