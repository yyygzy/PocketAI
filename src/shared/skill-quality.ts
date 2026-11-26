// 技能描述质量检查的纯函数层：过短、缺 when-to-use、与另一技能高度相似。
// 只产出事实与建议；不阻断导入，也不改路由/工具权限。
import { tokenizeForRouting } from './skill-routing'

export type SkillQualityCode = 'DESC_TOO_SHORT' | 'DESC_NO_WHEN_TO_USE' | 'DESC_SIMILAR'

export interface SkillQualityIssue {
  code: SkillQualityCode
  skillId: string
  skillName: string
  detail: string
  /** 仅 DESC_SIMILAR：与哪条技能相似 */
  relatedSkillId?: string
  relatedSkillName?: string
  score?: number
}

export interface QualityCheckSkill {
  id: string
  name: string
  description: string
}

/** 低于这个字符数就很难承担"描述决定触发"的职责 */
export const SKILL_DESC_MIN_CHARS = 20
/** 描述词集 Jaccard 超过这条线才算高度相似 */
export const SKILL_SIMILARITY_THRESHOLD = 0.72

const WHEN_TO_USE_PATTERN = /(when|use\s+when|should\s+be\s+used|trigger|当|用于|适用于|遇到|需要|用来|帮助|处理)/i

export function checkSkillDescription(description: string): SkillQualityCode[] {
  const text = String(description ?? '').trim()
  const out: SkillQualityCode[] = []
  if (!text) return out
  if (text.length < SKILL_DESC_MIN_CHARS) out.push('DESC_TOO_SHORT')
  if (!WHEN_TO_USE_PATTERN.test(text)) out.push('DESC_NO_WHEN_TO_USE')
  return out
}

/** 词集 Jaccard：同一份 tokenizer，既用于路由也用于相似度，避免两套口径漂移 */
export function descriptionSimilarity(a: string, b: string): number {
  const left = new Set(tokenizeForRouting(a))
  const right = new Set(tokenizeForRouting(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const term of left) if (right.has(term)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** 全量描述体检：单条警告 + 两两相似对（每对只报一次） */
export function auditSkillDescriptions(
  skills: QualityCheckSkill[],
  threshold: number = SKILL_SIMILARITY_THRESHOLD
): SkillQualityIssue[] {
  const issues: SkillQualityIssue[] = []
  for (const skill of skills) {
    for (const code of checkSkillDescription(skill.description)) {
      issues.push({
        code,
        skillId: skill.id,
        skillName: skill.name,
        detail: code === 'DESC_TOO_SHORT'
          ? `描述只有 ${skill.description.trim().length} 字，建议写清用途与何时使用`
          : '描述缺少 when-to-use（何时该用这条技能）'
      })
    }
  }

  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const a = skills[i]!
      const b = skills[j]!
      const score = descriptionSimilarity(a.description, b.description)
      if (score < threshold) continue
      issues.push({
        code: 'DESC_SIMILAR',
        skillId: a.id,
        skillName: a.name,
        relatedSkillId: b.id,
        relatedSkillName: b.name,
        score,
        detail: `与「${b.name}」的描述高度相似（${(score * 100).toFixed(0)}%），模型难以按描述区分`
      })
    }
  }
  return issues
}
