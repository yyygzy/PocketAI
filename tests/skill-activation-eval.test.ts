// 技能 activation eval：固定 prompt 卷子在 CI 里跑触发准确率，并记录基线。
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { routeSkills } from '../src/shared/skill-routing'
import {
  evaluateSkillEvalCase,
  parseSkillEvalSet,
  summarizeSkillEval,
  type SkillEvalRow
} from '../src/shared/skill-eval'
import { auditSkillDescriptions } from '../src/shared/skill-quality'

const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'skill-activation-eval.json')
const set = parseSkillEvalSet(fs.readFileSync(FIXTURE, 'utf8'))

function run(): { rows: SkillEvalRow[]; summary: ReturnType<typeof summarizeSkillEval> } {
  const rows = set.cases.map((evalCase) => {
    const decision = routeSkills(set.skills, evalCase.prompt, set.topN)
    return evaluateSkillEvalCase(evalCase, decision.selected.map((s) => s.id), set.topN)
  })
  return { rows, summary: summarizeSkillEval(rows, set.topN) }
}

describe('activation eval 基线', () => {
  it('卷子格式合法：期望技能都在卷内，case id 不重复', () => {
    expect(set.cases.length).toBe(8)
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length)
    const skillIds = new Set(set.skills.map((s) => s.id))
    expect(set.cases.every((c) => c.expected.every((id) => skillIds.has(id)))).toBe(true)
  })

  it('CI 基线 8/8@1、8/8@2（守住 top-1 ≥ 75%，top-N ≥ 87.5%）', () => {
    const { summary } = run()
    expect(summary.total).toBe(8)
    expect(summary.top1Accuracy).toBeGreaterThanOrEqual(0.75)
    expect(summary.topKAccuracy).toBeGreaterThanOrEqual(0.875)
    // 基线读数留在失败信息里，漂移时能一眼看出退回哪一档
    expect(`${summary.top1Hits}/${summary.total}@1 ${summary.topKHits}/${summary.total}@${summary.topN}`)
      .toMatch(/^\d+\/8@1 \d+\/8@2$/)
  })

  it('路由给出的 top-N 不超出卷子声明', () => {
    const { rows } = run()
    expect(rows.every((r) => r.routed.length <= set.topN)).toBe(true)
  })
})

describe('描述质量', () => {
  it('基线卷子里的描述都不短且带 when-to-use', () => {
    const issues = auditSkillDescriptions(set.skills)
    expect(issues.filter((i) => i.code === 'DESC_TOO_SHORT' || i.code === 'DESC_NO_WHEN_TO_USE')).toEqual([])
  })

  it('两条几乎相同的描述报相似，且每对只报一次', () => {
    const issues = auditSkillDescriptions([
      { id: 'a', name: '甲', description: '当需要在提交前审查代码质量、性能与安全隐患时使用这条技能' },
      { id: 'b', name: '乙', description: '当需要在提交前审查代码质量、性能与安全隐患时使用这条技能' },
      { id: 'c', name: '丙', description: '需要把中文翻译成英文或其他语言时使用这条技能' }
    ])
    const similar = issues.filter((i) => i.code === 'DESC_SIMILAR')
    expect(similar).toHaveLength(1)
    expect(similar[0]!.relatedSkillId).toBe('b')
  })

  it('坏卷子当场拒绝，不带着假期望进 CI', () => {
    expect(() => parseSkillEvalSet('{')).toThrow('合法 JSON')
    expect(() => parseSkillEvalSet(JSON.stringify({ ...set, cases: [{ id: 'x', prompt: 'p', expected: ['missing'] }] })))
      .toThrow('期望技能不在卷内')
  })
})
