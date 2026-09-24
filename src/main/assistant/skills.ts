// 技能上下文构建：把助手关联的技能格式化为 SystemPrompt 注入片段
import { skillRepo } from '../db/repositories/skill.repo'
import type { SkillRecord } from '../../shared/types'

/** 格式化单个技能为提示词片段 */
export function formatSkill(s: SkillRecord): string {
  const desc = s.description ? `\n（${s.description}）` : ''
  return `### ${s.icon} ${s.name}${desc}\n${s.content.trim()}`
}

/**
 * 按助手配置的 skillIds 构建技能注入块。
 * 只取存在且 enabled 的技能；无有效技能返回空字符串。
 */
export function buildSkillsContext(skillIds: string[]): string {
  const skills = skillRepo.listEnabledByIds(skillIds ?? [])
  if (skills.length === 0) return ''
  const body = skills.map(formatSkill).join('\n\n')
  return `## 已启用技能\n\n以下是当前助手启用的技能指令，请在回答中严格遵循：\n\n${body}`
}
