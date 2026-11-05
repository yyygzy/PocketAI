// @vitest-environment jsdom
// V4-Iter-412（P0-1 第二枚）：助手编辑器不许把**停用**的技能新增绑定
//
// 现场（改前）：技能清单里停用那条与启用那条长一样、点一样，勾上就写进 `skillIds`；
// 而运行期取技能走 `skillRepo.listEnabledByIds`（`src/main/assistant/skills.ts` 那条链），
// 停用的那条被**静默跳过** ⇒ 用户勾了、界面显示选中、对话里一个字都没有＝"绑了等于没绑"那张谎脸。
//
// 口径（按选定：不可选＋一句四语提示）：
//  · 停用且**没绑过**的 ⇒ `disabled`，鼠标停在上面就是那句原因，chip 组下方同屏再摆一句（不靠 hover 才能看见）；
//  · 已绑且后来停用的 ⇒ **留在屏上、照常可点**——取消绑定是用户的决定，不是我们替他做的；
//    这一档还要在名字后面挂一枚「已停用」，否则屏上看不出这条其实没在生效。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { AssistantEditor } from '../src/renderer/src/modules/chat/AssistantEditor'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SkillRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const skillOf = (id: string, enabled: boolean): SkillRecord =>
  ({ id, name: `PROBE-${id}`, icon: '⚡', description: '一支技能', enabled }) as unknown as SkillRecord

async function mount(skills: SkillRecord[], skillIds: string[] = []) {
  stubPocketai({
    listKnowledgeBases: () => [],
    listAvailableTools: () => [],
    listSkills: () => skills,
    saveAssistant: (a: Record<string, unknown>) => a
  })
  const view = mountWithProviders(
    <AssistantEditor
      initial={{ id: 'a-1', name: 'PROBE-助手', skillIds } as never}
      providers={[]}
      onCancel={() => {}}
      onSaved={() => {}}
    />
  )
  // 技能那一读是挂载后发出的 ⇒ 门里等的是"chip 到货"本身（§364：不等到货就同步读屏会在负载窗里假红）
  await waitFor(() => expect(document.querySelector('[data-skill-chip]')).toBeTruthy(), MOUNT_BUDGET)
  return view
}

const chip = (id: string): HTMLButtonElement =>
  document.querySelector(`[data-skill-chip="${id}"]`) as HTMLButtonElement

/**
 * 点保存并等那一发落地，再把载荷取回来（屏上看不出 skillIds 最终写成了什么）。
 * 门里等的是"这一发出现了"＝到货见证本身（§364：门不许只断"不存在"，否则 t=0 就放行、紧随的读屏会假红）。
 */
async function save(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByText(L('common.save')))
  let payload: Record<string, unknown> | undefined
  await waitFor(() => {
    const c = pocketaiCalls().find((x) => x.fn === 'saveAssistant')
    if (!c) throw new Error('等待 saveAssistant')
    payload = c.args[0] as Record<string, unknown>
  }, MOUNT_BUDGET)
  return payload!
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('412 编辑器：停用的技能不给新增绑定', () => {
  it('清单里有一条停用且没绑过 ⇒ 那颗 chip 按不动、有一句说为什么', async () => {
    await mount([skillOf('sk-on', true), skillOf('sk-off', false)])
    const c = chip('sk-off')
    expect(c.disabled, '勾了也用不上，就不该让人勾').toBe(true)
    expect(c.getAttribute('data-skill-blocked')).toBe('true')
    expect(c.title).toBe(L('ae.skillDisabledHint'))
    expect(await screen.findByTestId('ae-skill-disabled-hint', {}, MOUNT_BUDGET)).toBeTruthy()
    expect(screen.getByTestId('ae-skill-disabled-hint').textContent).toBe(L('ae.skillDisabledHint'))
    // 启用那条不受牵连：照旧可点、没有 blocked 标记
    expect(chip('sk-on').disabled).toBe(false)
    expect(chip('sk-on').getAttribute('data-skill-blocked')).toBeNull()
  })

  it('点了那颗按不动的也不进载荷 ⇒ 保存出去的 skillIds 里没有停用那条', async () => {
    await mount([skillOf('sk-on', true), skillOf('sk-off', false)])
    fireEvent.click(chip('sk-off'))
    fireEvent.click(chip('sk-on'))
    const payload = await save()
    expect(payload.skillIds).toEqual(['sk-on'])
  })

  it('已绑但后来停用的 ⇒ 留在屏上、可点掉，并挂一枚「已停用」', async () => {
    await mount([skillOf('sk-off', false)], ['sk-off'])
    const c = chip('sk-off')
    expect(c.disabled, '取消绑定是用户的决定，不许把它锁在屏上').toBe(false)
    expect(c.textContent).toContain(L('ae.skillDisabledTag'))
    expect(screen.queryByTestId('ae-skill-disabled-hint'), '没有"想绑但绑不了"的那条就不该出现那句提示').toBeNull()
    fireEvent.click(c)
    const payload = await save()
    expect(payload.skillIds).toEqual([])
  })

  it('反向对照：全启用 ⇒ 既没有按不动的 chip，也没有那句提示', async () => {
    await mount([skillOf('sk-on', true), skillOf('sk-on2', true)])
    expect(document.querySelectorAll('[data-skill-blocked="true"]').length).toBe(0)
    expect(screen.queryByTestId('ae-skill-disabled-hint')).toBeNull()
    fireEvent.click(chip('sk-on2'))
    const payload = await save()
    expect(payload.skillIds).toEqual(['sk-on2'])
  })
})
