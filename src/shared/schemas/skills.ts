// 技能 IPC 入参 schema
// 技能 content 会直接拼接进 LLM system prompt，属 LLM 注入面；
// 导入/远程拉取的技能（skillShapeSchema）同样不可信。统一带资源上限，
// 防渲染层被攻破后巨型/畸形 payload 落库并进入每次对话的上下文。
import { z } from 'zod'

// ─── 资源上限（宽松，正常使用不可达） ────────────────────────────
const SKILL_MAX_NAME_CHARS = 100
const SKILL_MAX_DESC_CHARS = 500
const SKILL_MAX_ICON_CHARS = 100
/** 技能正文（进 system prompt），对齐单条会话 content 上限的 1/20 */
const SKILL_MAX_CONTENT_CHARS = 50_000
const SKILL_MAX_TAG_CHARS = 50
const SKILL_MAX_TAGS = 20
const SKILL_MAX_ID_CHARS = 64

const skillTags = z.array(z.string().max(SKILL_MAX_TAG_CHARS)).max(SKILL_MAX_TAGS)

const skillRecordFull = z.object({
  id: z.string().min(1).max(SKILL_MAX_ID_CHARS),
  name: z.string().min(1).max(SKILL_MAX_NAME_CHARS),
  description: z.string().max(SKILL_MAX_DESC_CHARS),
  icon: z.string().max(SKILL_MAX_ICON_CHARS),
  content: z.string().max(SKILL_MAX_CONTENT_CHARS),
  enabled: z.boolean(),
  isBuiltin: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** SKILL_SAVE 入参：Partial<SkillRecord> & { name: string } */
export const skillSaveSchema = skillRecordFull
  .partial()
  .extend({ name: z.string().min(1).max(SKILL_MAX_NAME_CHARS) })

/** SkillShape（parseSkillText 输出）：导入/远程拉取后的技能结构 */
export const skillShapeSchema = z.object({
  name: z.string().min(1).max(SKILL_MAX_NAME_CHARS),
  description: z.string().max(SKILL_MAX_DESC_CHARS),
  icon: z.string().max(SKILL_MAX_ICON_CHARS),
  content: z.string().max(SKILL_MAX_CONTENT_CHARS),
  version: z.string().max(50).optional(),
  author: z.string().max(100).optional(),
  tags: skillTags.optional(),
  category: z.string().max(50).optional()
})
