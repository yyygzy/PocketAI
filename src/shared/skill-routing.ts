// 运行时技能路由的纯函数层：只按任务描述给技能打分、选 top-N，不碰 DB、不碰网络、不改工具权限。
//
// 边界：
//  · 默认关闭，调用方显式开启且给了任务描述时才改注入顺序；
//  · 没命中任何词的技能不会被硬塞进 top-N，宁可只给指针；
//  · 分数只决定"哪几条正文进 SystemPrompt"，不决定是否允许调用任何工具。
export interface RoutableSkill {
  id: string
  name: string
  description: string
  category?: string
  tags?: string[]
}

export interface SkillRoutingOptions {
  enabled?: boolean
  taskDescription?: string
  topN?: number
}

export interface SkillRoutingDecision<T extends RoutableSkill> {
  enabled: boolean
  selected: T[]
  deferred: T[]
  scores: Record<string, number>
  topN: number
}

export const DEFAULT_SKILL_ROUTING_TOP_N = 3
const MAX_SKILL_ROUTING_TOP_N = 10

export function clampSkillRoutingTopN(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SKILL_ROUTING_TOP_N
  return Math.min(MAX_SKILL_ROUTING_TOP_N, Math.max(1, Math.floor(n)))
}

/** 中英混合分词：英文/数字按词，中文按单字 + 双字，保证短中文描述也能有重叠信号 */
export function tokenizeForRouting(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const terms = new Set<string>()
  for (const m of lower.match(/[a-z0-9_+#.-]{2,}/g) ?? []) terms.add(m)
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length; i += 1) terms.add(run[i]!)
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2))
  }
  return [...terms]
}

/**
 * 按任务描述选择要全文注入的技能；其余技能交给调用方按能力给指针或省略。
 * 同分时保持原绑定顺序，保证同一输入多次运行结果一致。
 */
export function routeSkills<T extends RoutableSkill>(
  skills: T[],
  taskDescription: string,
  topN: number = DEFAULT_SKILL_ROUTING_TOP_N
): SkillRoutingDecision<T> {
  const task = String(taskDescription ?? '').trim()
  const limit = clampSkillRoutingTopN(topN)
  if (!task) {
    return { enabled: false, selected: [...skills], deferred: [], scores: {}, topN: limit }
  }

  const taskTerms = new Set(tokenizeForRouting(task))
  const scored = skills.map((skill, index) => {
    const nameTerms = new Set(tokenizeForRouting(skill.name))
    const descTerms = new Set(
      tokenizeForRouting([skill.description, skill.category ?? '', ...(skill.tags ?? [])].join(' '))
    )
    let score = 0
    for (const term of taskTerms) {
      if (nameTerms.has(term)) score += 3
      if (descTerms.has(term)) score += 2
    }
    return { skill, index, score }
  })

  const scores: Record<string, number> = {}
  for (const item of scored) scores[item.skill.id] = item.score

  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.skill)
  const selectedIds = new Set(selected.map((s) => s.id))

  return {
    enabled: true,
    selected,
    deferred: skills.filter((s) => !selectedIds.has(s.id)),
    scores,
    topN: limit
  }
}
