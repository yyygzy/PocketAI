// 助手市场详情页「关联技能」：skill_ids join 全局技能清单，只展示图标 + 名称。
//
// 三条硬约束（见 AssistantMarket 里的注释）：
//  · skill_ids 为空 ⇒ 不发清单那一读，区块不渲染（"没有引用"不是"能力缺失"）；
//  · 清单读不到 ⇒ 同样不渲染（"不知道"不许画成"没有"）；
//  · 内置助手与自定义助手走同一条路径。
// 本文件只用 findBy*/act 做同步，不用 `await waitFor`（§364 那本账按文件登记等待门）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { calledFns, mountWithProviders, stubPocketai } from './helpers/renderer'
import { AssistantMarket } from '../src/renderer/src/modules/chat/AssistantMarket'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const SKILL_TITLE = L('am.skills')

const S1 = {
  id: 's1', name: 'PROBE-技能一', description: '', icon: '⚡', content: '',
  resident: false, enabled: true, isBuiltin: false, createdAt: 1
} as unknown as SkillRecord
const S2 = {
  id: 's2', name: 'PROBE-技能二', description: '', icon: '🧪', content: '',
  resident: false, enabled: true, isBuiltin: false, createdAt: 2
} as unknown as SkillRecord

const assistant = (over: Partial<AssistantRecord>): AssistantRecord => ({
  id: 'a1',
  name: 'PROBE-助手',
  avatar: '🤖',
  description: '',
  systemPrompt: '',
  toolPermissions: [],
  skillIds: [],
  knowledgeBaseIds: [],
  welcomeMessage: '',
  isBuiltin: true,
  isPinned: false,
  enabled: true,
  ...over
} as unknown as AssistantRecord)

const mountMarket = (over: Record<string, (...a: any[]) => unknown> = {}): ReturnType<typeof mountWithProviders> => {
  stubPocketai({ listAssistants: () => [assistant({ skillIds: ['s1', 's2'] })], ...over })
  return mountWithProviders(<AssistantMarket providers={[]} onClose={() => {}} onChanged={() => {}} />)
}

const openDetail = async (): Promise<void> => {
  await screen.findByText('PROBE-助手')
  fireEvent.click(screen.getByText('PROBE-助手'))
}

beforeEach(() => {
  localStorage.clear()
})

describe('助手市场详情：关联技能（skill_ids join skills）', () => {
  it('有引用且清单读到 ⇒ 按 skill_ids 顺序摆图标 + 名称，只读一次清单', async () => {
    mountMarket({ listSkills: () => [S2, S1] })
    await openDetail()
    await screen.findByTestId('assistant-market-skills')
    expect(screen.getByText(SKILL_TITLE)).toBeTruthy()
    // 顺序跟 skill_ids 走，不跟清单顺序走
    const names = screen.getAllByText(/PROBE-技能[一二]/).map((e) => e.textContent)
    expect(names).toEqual([S1.name, S2.name])
    expect(screen.getByText('⚡')).toBeTruthy()
    expect(calledFns().filter((f) => f === 'listSkills')).toHaveLength(1)
  })

  it('skill_ids 为空 ⇒ 区块不渲染，也不发清单那一读', async () => {
    const r = mountMarket({ listAssistants: () => [assistant({ skillIds: [] })], listSkills: () => [S1] })
    await openDetail()
    expect(screen.queryByTestId('assistant-market-skills')).toBeNull()
    expect(screen.queryByText(SKILL_TITLE)).toBeNull()
    expect(calledFns()).not.toContain('listSkills')
    r.unmount()
  })

  it('清单读不到（失败对象）⇒ 区块不渲染，也不摆"没有技能"一类空态', async () => {
    mountMarket({ listSkills: () => ({ ok: false, error: 'SK:技能通道断了' }) })
    await openDetail()
    await act(async () => { /* 等 .then 的失败分支落定 */ })
    expect(screen.queryByTestId('assistant-market-skills')).toBeNull()
    expect(screen.queryByText(SKILL_TITLE)).toBeNull()
  })

  it('清单读不到（reject）⇒ 同样不渲染', async () => {
    mountMarket({ listSkills: () => Promise.reject(new Error('技能通道断了')) })
    await openDetail()
    await act(async () => { /* 等 .catch 落定 */ })
    expect(screen.queryByTestId('assistant-market-skills')).toBeNull()
  })

  it('自定义助手同样适用（非内置）', async () => {
    mountMarket({
      listAssistants: () => [assistant({ id: 'u1', name: 'PROBE-我的助手', isBuiltin: false, skillIds: ['s1'] })],
      listSkills: () => [S1]
    })
    await screen.findByText('PROBE-我的助手')
    fireEvent.click(screen.getByText('PROBE-我的助手'))
    await screen.findByTestId('assistant-market-skills')
    expect(screen.getByText('PROBE-技能一')).toBeTruthy()
  })
})
