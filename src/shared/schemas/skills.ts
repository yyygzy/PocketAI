// 技能 IPC 入参 schema
import { z } from 'zod'

const skillRecordFull = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  icon: z.string(),
  content: z.string(),
  enabled: z.boolean(),
  isBuiltin: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** SKILL_SAVE 入参：Partial<SkillRecord> & { name: string } */
export const skillSaveSchema = skillRecordFull
  .partial()
  .extend({ name: z.string().min(1) })

/** SkillShape（parseSkillText 输出）：导入/远程拉取后的技能结构 */
export const skillShapeSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  icon: z.string(),
  content: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional()
})
