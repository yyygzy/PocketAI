// @vitest-environment jsdom
// V4-Iter-412（P0-1 第三枚）：技能市场里"装完就地绑定"那一行
//
// 现场（改前）：技能屏与技能市场能新建、能导入、能启用，但**没有任何地方**能把一条技能接到助手身上——
// 助手编辑器的技能区读的是 `listSkills()` 的整表、勾选写 `skillIds`，而市场里连助手清单都没拉过。
// 结果："我装完这个技能，它就该在这个助手里生效"这件事从来没成立过。
//
// 三条口径：
//  ① 详情屏上摊开助手清单，已绑的画 ✓、没绑的给一颗「绑定」键（≤3 步：导入 → 详情 → 绑定）；
//  ② 停用那条不给键，只说一句"先启用才能绑定"——绑了运行期也会被 `listEnabledByIds` 跳过＝按了没反应的那张脸；
//  ③ 助手那一读失败要上屏并配一颗**同级**重试键（§268：键在 alert 盒子外面，否则会被念进那句的 textContent）。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { SkillMarket } from '../src/renderer/src/modules/skills/SkillMarket'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const REASON = 'IO:助手清单读不到'

const SKILL_ON = {
  id: 'sk1', name: 'PROBE-技能', icon: '⚡', description: '一支技能', content: '正文', enabled: true
} as unknown as SkillRecord
const SKILL_OFF = { ...SKILL_ON, id: 'sk2', name: 'PROBE-停用技能', enabled: false }
const A_FREE = {
  id: 'a1', name: 'PROBE-空闲助手', skillIds: []
} as unknown as AssistantRecord
const A_BOUND = {
  id: 'a2', name: 'PROBE-已绑助手', skillIds: ['sk1']
} as unknown as AssistantRecord
/**
 * §414（真机轮撞出来的）：内置助手改不动——`assistant.repo.save()` 对内置直接抛
 * 「内置助手不可编辑，请先复制为我的助手」⇒ 新装机上那一排八颗「绑定」键按下去必失败。
 */
const A_BUILTIN_FREE = {
  id: 'a3', name: 'PROBE-内置未绑', isBuiltin: true, skillIds: []
} as unknown as AssistantRecord
const A_BUILTIN_BOUND = {
  id: 'a4', name: 'PROBE-内置已绑', isBuiltin: true, skillIds: ['sk1']
} as unknown as AssistantRecord

function mount(over: Record<string, (...a: any[]) => unknown> = {}) {
  stubPocketai({
    listSkills: () => [SKILL_ON, SKILL_OFF],
    listAssistants: () => [A_FREE, A_BOUND],
    saveAssistant: (a: Record<string, unknown>) => a,
    syncSkills: () => ({ count: 0, errors: [] }),
    fetchSkillIndex: () => ({ ok: true, skills: [] }),
    ...over
  })
  return mountWithProviders(
    <SkillMarket onClose={() => {}} onChanged={async () => [SKILL_ON, SKILL_OFF]} />
  )
}

/** 走进某条技能的详情屏：市场默认停在本地 tab 的网格，点卡片进详情 */
async function openDetail(name: string): Promise<void> {
  const card = await screen.findByText(name, {}, MOUNT_BUDGET)
  const btn = card.closest('button')
  if (!btn) throw new Error(`PROBE：${name} 那张卡片外面没有按钮`)
  fireEvent.click(btn)
  await screen.findByText(L('skill.market.bindTitle'), {}, MOUNT_BUDGET)
}

const bindButton = (assistantId: string): HTMLButtonElement | null =>
  document.querySelector(`[data-skill-bind="${assistantId}"]`) as HTMLButtonElement | null

/** 那一发 saveAssistant 的载荷（点绑定后落库的就是它） */
async function savedOnce(): Promise<Record<string, unknown>> {
  let args: Record<string, unknown> | undefined
  await waitFor(
    () => {
      const c = pocketaiCalls().find((x) => x.fn === 'saveAssistant')
      if (!c) throw new Error('等待 saveAssistant')
      args = c.args[0] as Record<string, unknown>
    },
    MOUNT_BUDGET
  )
  return args!
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('412 市场：详情屏上就能把技能绑到助手', () => {
  it('已绑的那位画 ✓、没绑的那位给键；点了 ⇒ 载荷带着这条技能，屏上说绑好了', async () => {
    await mount()
    await openDetail(SKILL_ON.name)
    expect(document.querySelector('[data-skill-bound="a2"]'), '已绑的那位要认得出来').toBeTruthy()
    expect(bindButton('a2'), '已绑的不该再给一颗"绑定"（按了只会重复写）').toBeNull()

    const btn = bindButton('a1')
    expect(btn).toBeTruthy()
    fireEvent.click(btn!)
    const payload = await savedOnce()
    expect(payload.id).toBe('a1')
    expect(payload.skillIds).toEqual(['sk1'])
    expect(bodyText()).toContain(L('skill.market.bindButton'))
    const done = L('skill.market.bindDone').replace('{name}', A_FREE.name)
    await waitFor(() => expect(bodyText()).toContain(done), MOUNT_BUDGET)
  })

  it('一条都没绑过时那句「未绑定到任何助手」在，绑上之后就不在（空态不是常驻的）', async () => {
    await mount({ listAssistants: () => [A_FREE] })
    await openDetail(SKILL_ON.name)
    expect(screen.getByTestId('skill-market-bind-none').textContent).toBe(L('skill.market.bindNone'))
    fireEvent.click(bindButton('a1')!)
    await savedOnce()
    const done = L('skill.market.bindDone').replace('{name}', A_FREE.name)
    await waitFor(() => expect(bodyText()).toContain(done), MOUNT_BUDGET)
    expect(screen.queryByTestId('skill-market-bind-none')).toBeNull()
  })

  it('绑那一发回 {ok:false} ⇒ 说「绑定失败：原因」，不许报成功', async () => {
    await mount({ saveAssistant: () => ({ ok: false, error: 'License：助手数量已满' }) })
    await openDetail(SKILL_ON.name)
    fireEvent.click(bindButton('a1')!)
    await waitFor(() => expect(bodyText()).toContain('License：助手数量已满'), MOUNT_BUDGET)
    expect(bodyText(), '失败载荷不能同时被当成成功').not.toContain(
      L('skill.market.bindDone').replace('{name}', A_FREE.name)
    )
    // 而且屏上那位还画着"没绑"——失败不许把 ✓ 提前点上去
    expect(document.querySelector('[data-skill-bound="a1"]')).toBeNull()
    expect(bindButton('a1'), '失败后那颗键还在，可以直接重试').toBeTruthy()
  })

  it('停用的技能不给绑定键，只说一句"先启用才能绑定"', async () => {
    await mount()
    await openDetail(SKILL_OFF.name)
    expect(screen.getByTestId('skill-market-bind-disabled').textContent).toBe(L('skill.market.bindDisabledHint'))
    expect(document.querySelectorAll('[data-skill-bind]').length, '按了没反应的键不该造出来').toBe(0)
    expect(document.querySelectorAll('[data-skill-bound]').length).toBe(0)
  })

  it('助手那一读失败 ⇒ 说一句并配一颗同级重试键；点了读到 ⇒ 长出绑定键、那句收回', async () => {
    let reads = 0
    await mount({
      listAssistants: () => {
        reads += 1
        return reads === 1 ? { ok: false, error: REASON } : [A_FREE, A_BOUND]
      }
    })
    await openDetail(SKILL_ON.name)
    const failed = L('common.loadFailedNamed')
      .replace('{what}', L('common.assistantsList'))
      .replace('{msg}', REASON)
    expect(bodyText()).toContain(failed)
    // §268 那颗键在 alert 盒子外面 ⇒ 那句的 textContent 里不许混进「重试」两个字
    const alert = screen.getByRole('alert')
    expect(alert.textContent, '盒子里放键会被念进句子').not.toContain(L('agent.retryRead'))
    expect(reads).toBe(1)

    fireEvent.click(screen.getByTestId('skill-market-assistants-retry'))
    await waitFor(() => expect(bindButton('a1')).toBeTruthy(), MOUNT_BUDGET)
    expect(reads, '重试只补发那一发').toBe(2)
    expect(bodyText()).not.toContain(failed)
  })

  it('反向对照：读到就什么都不欠 ⇒ 没有 alert、那颗键也不出现', async () => {
    await mount()
    await openDetail(SKILL_ON.name)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('skill-market-assistants-retry')).toBeNull()
  })

  /**
   * §322 同族的第四处：这一发也能叠着发（进市场、切 tab、重试键），而它比另几发多一层机关——
   * 绑定成功那一路会**本地改写** `assistants`。先发起的那条后回时写的是发出去之前那份快照，
   * 于是刚点出来的 ✓ 会无声退回成「绑定」那颗键（屏上开始说假话，而库里其实绑好了）。
   * 同一条用例里两个方向都要见证：最新那条确实写了屏（键长出来了），迟到那条没写（✓ 没被抹掉）。
   */
  it('迟到的那份助手清单不许把刚绑上的 ✓ 抹回「绑定」，而最新那条照写', async () => {
    let releaseFirst: ((v: unknown) => void) | null = null
    let reads = 0
    await mount({
      listAssistants: () => {
        reads += 1
        if (reads === 1)
          return new Promise((res) => {
            releaseFirst = res
          })
        return [A_FREE, A_BOUND]
      }
    })
    // 那颗重试键只在"读不到"时才长出来，这一支没读不到 ⇒ 用切 tab 这条真实路径再发一发
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('skill.market.tabOnline')) }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('skill.market.tabLocal')) }))
    await openDetail(SKILL_ON.name)
    expect(reads, '进市场一发＋两次切 tab 各一发').toBe(3)

    fireEvent.click(bindButton('a1')!)
    await waitFor(() => expect(document.querySelector('[data-skill-bound="a1"]')).toBeTruthy(), MOUNT_BUDGET)

    await act(async () => {
      ;(releaseFirst as unknown as (v: unknown) => void)([A_FREE, A_BOUND])
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(
      document.querySelector('[data-skill-bound="a1"]'),
      '迟到那条带着"还没绑"的旧快照，不该把 ✓ 抹回键'
    ).toBeTruthy()
    expect(bindButton('a1')).toBeNull()
  })

  /**
   * `.catch` 那一路（通道直接 reject，不是 `{ok:false}`）也要有牙：safeHandle 把主进程抛错转成返回值，
   * 但 preload 层自己坏掉时走的就是这条 ⇒ 同一张"读不到"的脸＋那颗重试键。
   */
  it('助手那一发是 reject 面时也是同一张脸（不是静默的空白）', async () => {
    let reads = 0
    await mount({
      listAssistants: () => {
        reads += 1
        // reject 面＝preload 那一层自己坏了（主进程抛错走的是 {ok:false}，那是另一张脸，上面已演）
        return reads === 1 ? Promise.reject(new Error('PROBE:通道坏了')) : [A_FREE, A_BOUND]
      }
    })
    await openDetail(SKILL_ON.name)
    const failed = L('common.loadFailedNamed')
      .replace('{what}', L('common.assistantsList'))
      .replace('{msg}', 'PROBE:通道坏了')
    await waitFor(() => expect(bodyText()).toContain(failed), MOUNT_BUDGET)
    fireEvent.click(screen.getByTestId('skill-market-assistants-retry'))
    await waitFor(() => expect(bindButton('a1')).toBeTruthy(), MOUNT_BUDGET)
    expect(bodyText()).not.toContain(failed)
    expect(reads).toBe(2)
  })

  /**
   * `.catch` 里那句代次判据的见证：坏消息也会迟到。
   * 最新那条已经把清单画上屏了，先发起的那条此时才 reject ⇒ 不许把"读到了"那一屏改口成"读不到"
   * （同族形状：写屏的三处——清单、失败句、loading——都归最新那条管，§322）。
   */
  it('迟到那条是 reject 面时不许把刚读到的清单说成「读不到」', async () => {
    let rejectFirst: ((e: unknown) => void) | null = null
    let reads = 0
    await mount({
      listAssistants: () => {
        reads += 1
        if (reads === 1)
          return new Promise((_res, rej) => {
            rejectFirst = rej
          })
        return [A_FREE, A_BOUND]
      }
    })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('skill.market.tabOnline')) }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('skill.market.tabLocal')) }))
    await openDetail(SKILL_ON.name)
    // 正向对照：最新那条确实写了屏（那颗键在、alert 不在），否则下面那句"不存在"是恒真的
    expect(bindButton('a1')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => {
      ;(rejectFirst as unknown as (e: unknown) => void)(new Error('PROBE:迟到的坏消息'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(screen.queryByRole('alert'), '迟到的坏消息不许改口成"读不到"').toBeNull()
    expect(bindButton('a1')).toBeTruthy()
  })

  it('内置助手那一格不给能点的键＝不可点＋同屏一句为什么，而按它确实什么都没发出去（§414）', async () => {
    await mount({ listAssistants: () => [A_FREE, A_BUILTIN_FREE] })
    await openDetail(SKILL_ON.name)
    const dead = bindButton('a3')
    expect(dead, '内置那位要留在名单里说清是谁，不能藏起来').toBeTruthy()
    expect(dead!.disabled, '必失败的那颗键不该让人按').toBe(true)
    expect(dead!.getAttribute('data-skill-blocked')).toBe('true')
    expect(dead!.title).toBe(L('skill.market.bindBuiltinHint'))
    const hint = screen.getByTestId('skill-market-bind-builtin-hint')
    expect(hint.textContent).toBe(L('skill.market.bindBuiltinHint'))
    // 同屏正向对照：非内置那位照旧可点、也不带那颗标记
    const live = bindButton('a1')!
    expect(live.disabled).toBe(false)
    expect(live.getAttribute('data-skill-blocked')).toBeNull()
    // 先按那颗按不动的、再按可点的 ⇒ 唯一那发的载荷只能是可点那位
    fireEvent.click(dead!)
    fireEvent.click(live)
    const payload = await savedOnce()
    expect(payload.id).toBe('a1')
    expect(pocketaiCalls().filter((c) => c.fn === 'saveAssistant').length, '按内置那颗不许真发那一发').toBe(1)
  })

  it('反向对照：没有"想绑却绑不了"的内置助手 ⇒ 那句不在；已绑的内置仍画 ✓、不给第二颗键（§414）', async () => {
    await mount({ listAssistants: () => [A_FREE, A_BUILTIN_BOUND] })
    await openDetail(SKILL_ON.name)
    expect(screen.queryByTestId('skill-market-bind-builtin-hint')).toBeNull()
    expect(document.querySelectorAll('[data-skill-blocked="true"]').length).toBe(0)
    expect(document.querySelector('[data-skill-bound="a4"]'), '已绑的内置画 ✓').toBeTruthy()
    expect(bindButton('a4'), '已绑的不该再给一颗键').toBeNull()
  })
})
