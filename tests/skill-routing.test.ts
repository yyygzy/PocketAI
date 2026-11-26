// 阶段 3 路由验收：纯函数打分 + 默认关闭回归 + 开箱后 top-N 全文/其余指针。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SkillRecord } from '../src/shared/types'

const { enabledSkills } = vi.hoisted(() => ({
  enabledSkills: { current: [] as SkillRecord[] }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { listEnabledByIds: (_ids: string[]) => enabledSkills.current }
}))

import { buildSkillsContext, buildSkillsContextResult } from '../src/main/assistant/skills'
import { routeSkills, tokenizeForRouting } from '../src/shared/skill-routing'

const skill = (over: Partial<SkillRecord>): SkillRecord => ({
  id: 's1', name: '技能', description: '', icon: '⚡', content: '正文',
  enabled: true, resident: true, isBuiltin: false, createdAt: 1,
  ...over
} as SkillRecord)

const SKILLS: SkillRecord[] = [
  skill({
    id: 'review', name: '代码审查', icon: '🔍', content: '审查正文',
    description: '当需要在提交前审查代码质量、性能与安全隐患时使用这条技能',
    tags: ['code', 'review']
  }),
  skill({
    id: 'translate', name: '翻译助手', icon: '🌐', content: '翻译正文',
    description: '需要把中文翻译成英文或其他语言时使用这条技能'
  }),
  skill({
    id: 'weekly', name: '周报助手', icon: '📝', content: '周报正文',
    description: '当要写周报、总结或工作汇报时使用这条技能'
  })
]

beforeEach(() => {
  enabledSkills.current = [...SKILLS]
})

describe('路由打分（纯函数）', () => {
  it('中英混合 token 都能参与重叠', () => {
    const terms = tokenizeForRouting('审查 TypeScript 代码')
    expect(terms).toContain('typescript')
    expect(terms).toContain('代码')
    expect(terms).toContain('审查')
  })

  it('按任务描述取 top-N，低分技能进 deferred，同分保持绑定顺序', () => {
    const d = routeSkills(SKILLS, '帮我审查 TypeScript 代码', 1)
    expect(d.enabled).toBe(true)
    expect(d.selected.map((s) => s.id)).toEqual(['review'])
    expect(d.deferred.map((s) => s.id)).toEqual(['translate', 'weekly'])
    expect(d.scores['review']!).toBeGreaterThan(d.scores['translate']!)

    const tie = routeSkills(SKILLS, '使用这条技能', 2)
    expect(tie.enabled).toBe(true)
    expect(tie.selected.map((s) => s.id)).toEqual(['review', 'translate'])

    const off = routeSkills(SKILLS, '', 2)
    expect(off.enabled).toBe(false)
    expect(off.selected.map((s) => s.id)).toEqual(['review', 'translate', 'weekly'])
  })

  it('没有任何词命中时不硬塞正文', () => {
    const d = routeSkills(SKILLS, '今天天气怎么样', 3)
    expect(d.selected).toEqual([])
    expect(d.deferred).toHaveLength(3)
  })
})

describe('注入结果', () => {
  it('开关关闭时逐字保持旧行为：全部全文、deferred 为空', () => {
    const r = buildSkillsContextResult(['review', 'translate', 'weekly'])
    expect(r.deferred).toEqual([])
    expect(r.text).toContain('审查正文')
    expect(r.text).toContain('翻译正文')
    expect(r.text).toContain('周报正文')
    // 旧调用只传 taskDescription 也不开启路由
    expect(buildSkillsContext(['review', 'translate'], { taskDescription: '翻译中文' })).toContain('审查正文')
  })

  it('开启后 top-N 给全文，其余只给指针（有 load 工具）', () => {
    const r = buildSkillsContextResult(['review', 'translate', 'weekly'], {
      loadToolAvailable: true,
      routing: { enabled: true, taskDescription: '把中文翻译成英文', topN: 1 }
    })
    expect(r.text).toContain('翻译正文')
    expect(r.text).not.toContain('审查正文')
    expect(r.text).not.toContain('周报正文')
    expect(r.text).toContain('代码审查')
    expect(r.deferred.map((s) => s.id)).toEqual(['review', 'weekly'])
  })

  it('没有 load 工具时被路由延后的技能不写出假指针', () => {
    const r = buildSkillsContextResult(['review', 'translate'], {
      loadToolAvailable: false,
      routing: { enabled: true, taskDescription: '审查代码', topN: 1 }
    })
    expect(r.text).toContain('审查正文')
    expect(r.text).not.toContain('load_skill')
    expect(r.deferred.map((s) => s.id)).toEqual(['translate', 'weekly'])
  })
})
