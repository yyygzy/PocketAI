// @vitest-environment jsdom
// V4-Iter-428：技能"启用 ≠ 在用"的可见性收口——原用例挂在 SkillMarket 上，
// §429 删除孤儿文件后迁到能力中心；能力中心用状态 chip（已启用·未绑定 / 已绑定 N）表达同一口径。
//
// 现场："我装完技能、也启用了，为什么对话里没有？"——屏上写着「已启用」，而运行期按助手的
// `skillIds` 取技能（∩ `skills.enabled`）。启用只是"可用"，没绑到助手就一次也进不了对话。
// 这一轮守三件事，都不涉及"哪个助手该配哪条技能"的内容决策：
//  ① 网格上每条技能看得见"几个助手在用"（0 也要看得见），口径 = 助手 `skillIds` 的实际引用；
//  ② 助手清单没读到过时**不画计数**——空数组不是"0 个助手在用"，那是"不知道"；
//  ③ 详情里启用键旁常驻一句实话：启用只是让技能可用，还需绑定；内置助手要先复制。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { AssistantRecord, SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const SKILL_ZERO = {
  id: 'sk0', name: 'PROBE-没人用', icon: '⚡', description: '一条技能', content: '正文', enabled: true
} as unknown as SkillRecord
const SKILL_ONE = {
  ...SKILL_ZERO, id: 'sk1', name: 'PROBE-有人用'
}
const SKILL_OFF = { ...SKILL_ZERO, id: 'sk2', name: 'PROBE-停用技能', enabled: false }

const A_BOUND = {
  id: 'a1', name: 'PROBE-已绑助手', skillIds: ['sk1']
} as unknown as AssistantRecord

function mount(over: Record<string, (...a: any[]) => unknown> = {}) {
  stubPocketai({
    listSkills: () => [SKILL_ZERO, SKILL_ONE, SKILL_OFF],
    listAssistants: () => [A_BOUND],
    listMcpServers: () => [],
    getMcpRuntimes: () => [],
    getToolPolicy: () => ({ tools: [] }),
    listProviders: () => [],
    onMcpStatus: () => () => {},
    onMcpLog: () => () => {},
    saveAssistant: (a: Record<string, unknown>) => a,
    ...over
  })
  return mountWithProviders(
    <CapabilityCenter onClose={() => {}} onChanged={async () => [SKILL_ZERO, SKILL_ONE, SKILL_OFF]} />
  )
}

/** 网格那张卡上的状态 chip（含"已绑定 N"或"已启用·未绑定"）；没这张卡返回 null */
const countOf = (name: string): string | null => {
  const card = screen.queryByText(name)?.closest('button')
  return card?.textContent ?? null
}

async function openDetail(name: string): Promise<void> {
  const card = await screen.findByText(name, {}, MOUNT_BUDGET)
  const btn = card.closest('button')
  if (!btn) throw new Error(`PROBE：${name} 那张卡片外面没有按钮`)
  fireEvent.click(btn)
  await screen.findByText(L('skill.market.bindTitle'), {}, MOUNT_BUDGET)
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('428 能力中心：启用 ≠ 在用', () => {
  it('网格上数的是助手 skillIds 的引用：1 个在用的显示 1，0 个的显示 0（两条都是"已启用"）', async () => {
    await mount()
    // 两条都启用——所以"启用"本身给不出区分度，计数必须来自助手绑定
    expect((SKILL_ZERO as unknown as { enabled: boolean }).enabled).toBe(true)
    expect((SKILL_ONE as unknown as { enabled: boolean }).enabled).toBe(true)

    await screen.findByTestId('capability-search', {}, MOUNT_BUDGET)
    const one = countOf(SKILL_ONE.name) ?? ''
    expect(one).toContain(L('cap.state.skill.bound').replace('{n}', '1'))
    expect(countOf(SKILL_ZERO.name), '0 也要看得见，不能只写"已启用"就完事').toContain(
      L('cap.state.skill.enabledUnbound')
    )
    expect(countOf(SKILL_OFF.name)).toContain(L('cap.state.skill.disabled'))
  })

  it('助手清单读不到 ⇒ 不画计数（"不知道"不许演成 0 个在用）；重试读到后补上', async () => {
    let reads = 0
    await mount({
      listAssistants: () => {
        reads += 1
        // 第二次给一位"还没绑"的助手，好在屏上长出可点的绑定键
        return reads === 1
          ? { ok: false, error: 'IO:助手清单读不到' }
          : [{ id: 'a1', name: 'PROBE-空闲助手', skillIds: [] }]
      }
    })
    await screen.findByText(SKILL_ONE.name, {}, MOUNT_BUDGET)
    // 给那一发失败一点落屏时间，再断言"没有"
    await waitFor(() => expect(reads).toBe(1), MOUNT_BUDGET)
    expect(countOf(SKILL_ONE.name), '读不到时不能长出一个假 0').not.toContain(
      L('cap.state.skill.enabledUnbound')
    )
    expect(countOf(SKILL_ZERO.name)).not.toContain(L('cap.state.skill.enabledUnbound'))
    expect(bodyText(), '更不能把那句"0 个助手在用"当成事实写出来').not.toContain(
      L('skill.market.userCountNone')
    )
    // 停用的那条仍如实说停用（这一条不依赖助手清单）
    expect(countOf(SKILL_OFF.name)).toContain(L('skill.off'))

    // 唯一的出口是详情里那颗同级重试键
    await openDetail(SKILL_ONE.name)
    fireEvent.click(screen.getByTestId('capability-assistants-retry'))
    await waitFor(() => expect(reads).toBe(2), MOUNT_BUDGET)
    await waitFor(() => expect(document.querySelector('[data-skill-bind="a1"]')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByTitle(L('common.back')))
    await screen.findByTestId('capability-search', {}, MOUNT_BUDGET)
    // 读到了就恢复计数（这位还没绑，所以如实显示"已启用·未绑定"，而不是把"不知道"留着）
    expect(countOf(SKILL_ONE.name)).toContain(L('cap.state.skill.enabledUnbound'))
    expect(countOf(SKILL_ZERO.name)).toContain(L('cap.state.skill.enabledUnbound'))
  })

  it('在详情里绑上之后回网格：那条的计数当场从 0 变 1（计数跟着真实 skillIds 走）', async () => {
    await mount({ listAssistants: () => [{ id: 'a1', name: 'PROBE-已绑助手', skillIds: [] }] })
    await screen.findByTestId('capability-search', {}, MOUNT_BUDGET)
    expect(countOf(SKILL_ONE.name)).toContain(L('cap.state.skill.enabledUnbound'))

    await openDetail(SKILL_ONE.name)
    await waitFor(() => expect(document.querySelector('[data-skill-bind="a1"]')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(document.querySelector('[data-skill-bind="a1"]') as HTMLButtonElement)
    // handleBind 成功后本地改写 assistants ⇒ 回网格时计数应立刻是 1
    await waitFor(() => expect(document.querySelector('[data-skill-bound="a1"]')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByTitle(L('common.back')))
    await waitFor(
      () => expect(countOf(SKILL_ONE.name)).toContain(L('cap.state.skill.bound').replace('{n}', '1')),
      MOUNT_BUDGET
    )
  })

  it('详情里启用/停用键旁有常驻实话（启用只＝可用），且文案不写"已生效"', async () => {
    await mount()
    await openDetail(SKILL_ZERO.name)
    const hint = screen.getByTestId('capability-enable-hint').textContent ?? ''
    expect(hint).toBe(L('skill.market.enableHint'))
    expect(hint, '这句必须说清"还要绑定"').toContain(L('skill.market.bindTitle'))
    expect(bodyText(), '不许把启用说成已生效').not.toContain('已生效')

    // 停用的那条也有开关，实话同样要在（不是只在启用态出现）
    fireEvent.click(screen.getByTitle(L('common.back')))
    await openDetail(SKILL_OFF.name)
    expect(screen.getByTestId('capability-enable-hint').textContent).toBe(
      L('skill.market.enableHint')
    )
  })

  it('四语新增键同批在位、占位符一致（en/ja/ko 不许漏译）', () => {
    const dicts = { zh, en, ja, ko } as Record<string, Record<string, string>>
    for (const [lang, d] of Object.entries(dicts)) {
      expect(d['skill.market.userCount'], `${lang} 缺 userCount`).toContain('{count}')
      expect(d['skill.market.userCountNone'], `${lang} 缺 userCountNone`).toBeTruthy()
      expect(d['skill.market.enableHint'], `${lang} 缺 enableHint`).toBeTruthy()
      expect(d['skill.market.userCount'], `${lang} 的 0 值文案得能看见 0`).toBeTruthy()
      expect(
        [d['skill.market.userCount'], d['skill.market.userCountNone'], d['skill.market.enableHint']].join(''),
        `${lang} 的文案不许出现"已生效"`
      ).not.toContain('已生效')
    }
  })
})
