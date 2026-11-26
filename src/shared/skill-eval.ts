// 技能 activation eval：固定 prompt → 期望被选中的技能 id。
// 判分是纯函数：只吃路由结果，不碰 DB / 网络 / 模型，CI 可以稳定跑基线。
import { z } from 'zod'
import { DEFAULT_SKILL_ROUTING_TOP_N, clampSkillRoutingTopN } from './skill-routing'

export const SKILL_EVAL_FILE_VERSION = 1

const MAX_CASES = 200
const MAX_PROMPT_CHARS = 2000
const MAX_ID_CHARS = 64
const MAX_NAME_CHARS = 200
const MAX_NOTE_CHARS = 500
const MAX_EXPECTED_PER_CASE = 5

const evalSkillSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_CHARS),
    name: z.string().min(1).max(MAX_NAME_CHARS),
    description: z.string().min(1).max(MAX_PROMPT_CHARS)
  })
  .strict()

const caseSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_CHARS),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    /** 期望技能 id；至少一条，否则 top-K 会假绿 */
    expected: z.array(z.string().min(1)).min(1).max(MAX_EXPECTED_PER_CASE),
    note: z.string().max(MAX_NOTE_CHARS).optional()
  })
  .strict()

export const skillEvalSetSchema = z
  .object({
    version: z.literal(SKILL_EVAL_FILE_VERSION),
    name: z.string().min(1).max(MAX_NAME_CHARS),
    topN: z.number().int().min(1).max(10).default(DEFAULT_SKILL_ROUTING_TOP_N),
    skills: z.array(evalSkillSchema).min(1),
    cases: z.array(caseSchema).min(1).max(MAX_CASES)
  })
  .strict()
  .superRefine((set, ctx) => {
    const skillIds = new Set(set.skills.map((s) => s.id))
    if (skillIds.size !== set.skills.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skills'], message: '评测技能 id 重复' })
    }
    const caseIds = new Set<string>()
    for (const [i, c] of set.cases.entries()) {
      if (caseIds.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'id'], message: `用例 id 重复：${c.id}` })
      }
      caseIds.add(c.id)
      for (const expectedId of c.expected) {
        if (!skillIds.has(expectedId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cases', i, 'expected'],
            message: `期望技能不在卷内：${expectedId}`
          })
        }
      }
    }
  })

export type SkillEvalSkill = z.infer<typeof evalSkillSchema>
export type SkillEvalCase = z.infer<typeof caseSchema>
export type SkillEvalSet = z.infer<typeof skillEvalSetSchema>

export function parseSkillEvalSet(text: string): SkillEvalSet {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('技能评测卷不是合法 JSON')
  }
  const parsed = skillEvalSetSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`技能评测卷格式错误：${parsed.error.issues.map((i) => i.message).join('；')}`)
  }
  return parsed.data
}

export function stringifySkillEvalSet(set: SkillEvalSet): string {
  return JSON.stringify(skillEvalSetSchema.parse(set), null, 2)
}

export interface SkillEvalRow {
  caseId: string
  prompt: string
  expected: string[]
  routed: string[]
  hitAt1: boolean
  hitAtK: boolean
}

export interface SkillEvalSummary {
  total: number
  top1Hits: number
  topKHits: number
  top1Accuracy: number
  topKAccuracy: number
  topN: number
}

export function evaluateSkillEvalCase(
  evalCase: SkillEvalCase,
  routedSkillIds: string[],
  topN: number = DEFAULT_SKILL_ROUTING_TOP_N
): SkillEvalRow {
  const k = clampSkillRoutingTopN(topN)
  const routed = routedSkillIds.slice(0, k)
  const expected = new Set(evalCase.expected)
  return {
    caseId: evalCase.id,
    prompt: evalCase.prompt,
    expected: [...evalCase.expected],
    routed,
    hitAt1: routed.length > 0 && expected.has(routed[0]!),
    hitAtK: routed.some((id) => expected.has(id))
  }
}

export function summarizeSkillEval(rows: SkillEvalRow[], topN: number = DEFAULT_SKILL_ROUTING_TOP_N): SkillEvalSummary {
  const total = rows.length
  const top1Hits = rows.filter((r) => r.hitAt1).length
  const topKHits = rows.filter((r) => r.hitAtK).length
  const k = clampSkillRoutingTopN(topN)
  return {
    total,
    top1Hits,
    topKHits,
    top1Accuracy: total === 0 ? 0 : top1Hits / total,
    topKAccuracy: total === 0 ? 0 : topKHits / total,
    topN: k
  }
}
