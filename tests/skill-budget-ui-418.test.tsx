// @vitest-environment jsdom
// 常驻预算的 UI 可见性（P0-3b 第二批）
//
// 只在屏上回答一件事：按绑定顺序，有几条会因总预算被**整份跳过**。
// 计算走主进程同一份规划函数（src/shared/skill-budget.ts），渲染端不另写阈值。
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AssistantEditor } from '../src/renderer/src/modules/chat/AssistantEditor'
import type { SkillRecord } from '../src/shared/types'

const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const skillOf = (id: string, chars: number): SkillRecord =>
  ({
    id,
    name: `PROBE-${id}`,
    icon: '⚡',
    description: '一支技能',
    enabled: true,
    resident: true,
    content: 'x'.repeat(chars)
  }) as unknown as SkillRecord

async function mount(skills: SkillRecord[], skillIds: string[]) {
  stubPocketai({
    listKnowledgeBases: () => [],
    listAvailableTools: () => [],
    listSkills: () => skills,
    saveAssistant: (a: Record<string, unknown>) => a
  })
  mountWithProviders(
    <AssistantEditor
      initial={{ id: 'a-1', name: 'PROBE-助手', skillIds } as never}
      providers={[]}
      onCancel={() => {}}
      onSaved={() => {}}
    />
  )
  await waitFor(() => expect(document.querySelector('[data-skill-chip]')).toBeTruthy(), MOUNT_BUDGET)
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('常驻总预算：超限在屏上可见', () => {
  it('5 条 9000 字符的已绑定技能 ⇒ 提示有 2 条会被整份跳过', async () => {
    const skills = Array.from({ length: 5 }, (_, i) => skillOf(`sk-${i}`, 9000))
    await mount(skills, skills.map((s) => s.id))
    const warn = await screen.findByTestId('ae-skill-budget-warn', {}, MOUNT_BUDGET)
    expect(warn.textContent).toContain('2')
    expect(warn.textContent).toContain('PROBE-sk-3')
  })

  it('反向对照：放得下就不出现提示', async () => {
    const skills = Array.from({ length: 3 }, (_, i) => skillOf(`sk-${i}`, 9000))
    await mount(skills, skills.map((s) => s.id))
    expect(screen.queryByTestId('ae-skill-budget-warn')).toBeNull()
  })
})
