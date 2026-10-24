// V4-Iter-270：第四面静默名单第三簇——助手编辑器那三发清单读。
//
// 名单现查 33 条里 `AssistantEditor.tsx:35/36/37` 占三条，而且是**同一屏的三份不同数据**：
// 知识库／工具／技能清单都在挂载那一次读，失败侧过去只有 `if (!hasIpcFailed(v)) setX(v)`＝什么都不做，
// 于是三块勾选区各摆「尚未创建知识库」「暂无可用工具」「暂无可用技能」——把通道故障演成"这台什么都没配"。
// 这一屏是新建／编辑助手的必经路（`AssistantMarket.tsx:211` 挂它），用户在这里勾完就保存，
// 演成"没有可勾的东西"比输入框里少一份菜单更重。
//
// 三条形状决定：
//  ① **三份各挂一句**（§268 口径）：它们是三份不同数据，不像 §269 那样并一张脸；
//  ② **每发各一颗重试键**（按选定口径）：三发都在挂载读，只有关掉编辑器再开才会重拉，
//     而那一趟会丢掉正在填的名称、SystemPrompt 与已勾选项 ⇒ 出口代价大到等于没出口；
//     各点各的发，一把键重发三份会把"另一发明明读到了"也说成不确定；
//  ③ 那句与那颗键共用一个 `listFailLine` 工厂 ⇒ 源码里只有一处 `role="alert"` 的字面量、三处调用，
//     闸门按**调用点的渲染条件**数，不按 alert 字面量数（§266 的 Z7 教训：盯条件本身）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AssistantEditor } from '../src/renderer/src/modules/chat/AssistantEditor'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, SkillRecord, ToolSchema } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const KB_WHAT = L('common.kbList')
const TOOLS_WHAT = L('common.toolsList')
const SKILLS_WHAT = L('common.skillsList')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const REASON = 'IO:通道断了'

/** 桩按真形状写死（§255 那条：混着桩会把判据落在错的形状上） */
const KB: KnowledgeBase = { id: 'kb1', name: 'PROBE-知识库', documentCount: 3, enabled: true } as unknown as KnowledgeBase
const TOOL: ToolSchema = { id: 'fs.read', name: 'PROBE-工具', description: '读文件', parameters: {}, source: 'builtin' }
const SKILL: SkillRecord = { id: 'sk1', name: 'PROBE-技能', icon: '⚡', description: '一支技能', enabled: true } as unknown as SkillRecord

function mount(over: Record<string, (...a: any[]) => unknown> = {}): ReturnType<typeof mountWithProviders> {
  stubPocketai({
    listKnowledgeBases: () => [KB],
    listAvailableTools: () => [TOOL],
    listSkills: () => [SKILL],
    saveAssistant: (a) => a,
    ...over
  })
  return mountWithProviders(
    <AssistantEditor initial={{ name: 'PROBE-助手' }} providers={[]} onCancel={() => {}} onSaved={() => {}} />
  )
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('① 知识库那一读：失败说一句、读到即收回，「尚未创建知识库」让位', () => {
  it('resolve 的失败对象 ⇒ 那句上屏，空态那张脸不再摆', async () => {
    mount({ listKnowledgeBases: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(KB_WHAT, REASON)]))
    expect(bodyText(), '把"读不到"演成"这台没建知识库"').not.toContain(L('ae.noKb'))
  })

  it('reject ⇒ 同一张脸（两条失败路都要写原因）', async () => {
    mount({ listKnowledgeBases: () => Promise.reject(new Error('REJECT-知识库')) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(KB_WHAT, 'REJECT-知识库')]))
  })

  it('反向对照：读到 ⇒ chip 上屏、零 alert', async () => {
    mount()
    await waitFor(() => expect(bodyText()).toContain('PROBE-知识库'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain(L('ae.noKb'))
  })

  it('那颗重试键：先失败再成功 ⇒ 那句自己退场、chip 上屏', async () => {
    let fail = true
    mount({ listKnowledgeBases: () => (fail ? { ok: false, error: REASON } : [KB]) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(KB_WHAT, REASON)]))
    fail = false
    fireEvent.click(screen.getByTestId('assistant-editor-kbs-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-知识库')
  })
})

describe('② 工具与技能那两读：各挂一句、各给一颗键', () => {
  it('工具读不到 ⇒ 「暂无可用工具」让位（那一格还挂着「全部允许」那颗键，不许顺带禁掉它）', async () => {
    mount({ listAvailableTools: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(TOOLS_WHAT, REASON)]))
    expect(bodyText(), '把"读不到"演成"这台没有工具"').not.toContain(L('ae.noTools'))
    const allowAll = screen.getByText(L('ae.allowAll')).closest('button')
    expect(allowAll, '「全部允许」那颗键仍在场').toBeTruthy()
    expect(allowAll!.disabled, '说实话不等于禁输入（§264 那条口径）').toBe(false)
  })

  it('技能读不到 ⇒ 「暂无可用技能」让位，那颗键点了有效', async () => {
    let fail = true
    mount({ listSkills: () => (fail ? { ok: false, error: REASON } : [SKILL]) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(SKILLS_WHAT, REASON)]))
    expect(bodyText()).not.toContain(L('ae.noSkills'))
    fail = false
    fireEvent.click(screen.getByTestId('assistant-editor-skills-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-技能')
  })

  it('工具读到而技能没读到 ⇒ 技能那格照常摆「暂无可用技能」（读到的一份不许被另一发说成不确定）', async () => {
    mount({ listSkills: () => [] })
    await waitFor(() => expect(bodyText()).toContain('PROBE-工具'), MOUNT_BUDGET)
    expect(bodyText()).toContain(L('ae.noSkills'))
    expect(alerts(), '真的没有 ≠ 读不到').toEqual([])
  })
})

describe('③ 三发互不干扰：一句只点自己的名、一颗键只重发自己那一发', () => {
  it('知识库＋工具两发都挂 ⇒ 两句同时在场、各点各的名，技能照常上屏', async () => {
    mount({
      listKnowledgeBases: () => ({ ok: false, error: 'KB:知识库通道断了' }),
      listAvailableTools: () => ({ ok: false, error: 'TOOLS:工具通道断了' })
    })
    await waitFor(() =>
      expect(alerts().sort()).toEqual(
        [FAILED(TOOLS_WHAT, 'TOOLS:工具通道断了'), FAILED(KB_WHAT, 'KB:知识库通道断了')].sort()
      )
    )
    expect(bodyText()).toContain('PROBE-技能')
    expect(bodyText(), '一句不许替另一发闭嘴，也不许把对方的名字带进来').not.toContain(FAILED(SKILLS_WHAT, ''))
  })

  it('点技能那颗键不会去重发知识库与工具', async () => {
    const calls = { kbs: 0, tools: 0, skills: 0 }
    mount({
      listKnowledgeBases: () => {
        calls.kbs += 1
        return [KB]
      },
      listAvailableTools: () => {
        calls.tools += 1
        return [TOOL]
      },
      listSkills: () => {
        calls.skills += 1
        return calls.skills === 1 ? { ok: false, error: REASON } : [SKILL]
      }
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(SKILLS_WHAT, REASON)]))
    const before = { ...calls }
    fireEvent.click(screen.getByTestId('assistant-editor-skills-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(calls.kbs, '知识库那一发不该被重发').toBe(before.kbs)
    expect(calls.tools, '工具那一发不该被重发').toBe(before.tools)
    expect(calls.skills, '技能这一发确实重发过一次').toBe(before.skills + 1)
  })
})

// ---------- §285 B157 收口：关掉再开自己会重拉（挂载效应在 unmount→mount 时重跑） ----------
// 那句"这一屏的天然出口是关掉编辑器重开"的形态判据此前只在源码级：`AssistantEditor.tsx:96` 那个
// `useEffect(() => { loadKbs(); loadTools(); loadSkills() }, [])`——组件在 AssistantMarket.tsx:248 是
// 条件挂载（`(view.mode === 'edit' || view.mode === 'create') && <AssistantEditor … />`），关闭编辑器
// 走 setView({mode:'grid'}) ⇒ 卸载；重开 ⇒ 重新挂 ⇒ 三发各再来一遍。这一形状此前没有任何 CI 读它——
// 有人把 useEffect 改成 "if (kbs.length) return"（首屏之后不再拉），或者把清单 store 挪进全局 memo 都会静默
// 让"重开重拉"这条出口失效，而屏上一句错都不冒。
describe('④ §285 B157：unmount→remount 三发都各自重跑一次', () => {
  it('关掉再开：三发各重跑一次（kbs／tools／skills 都从 1 涨到 2）', async () => {
    const calls = { kbs: 0, tools: 0, skills: 0 }
    const stubs = {
      listKnowledgeBases: () => {
        calls.kbs += 1
        return [KB]
      },
      listAvailableTools: () => {
        calls.tools += 1
        return [TOOL]
      },
      listSkills: () => {
        calls.skills += 1
        return [SKILL]
      }
    }
    const r1 = mount(stubs)
    await waitFor(
      () => {
        expect(calls.kbs).toBe(1)
        expect(calls.tools).toBe(1)
        expect(calls.skills).toBe(1)
      },
      MOUNT_BUDGET
    )
    r1.unmount()
    mount(stubs)
    await waitFor(
      () => {
        expect(calls.kbs, '关→重开必须重发知识库那一发').toBe(2)
        expect(calls.tools, '关→重开必须重发工具那一发').toBe(2)
        expect(calls.skills, '关→重开必须重发技能那一发').toBe(2)
      },
      MOUNT_BUDGET
    )
  })

  it('反向对照：重开不是沿用第一份清单——第二次挂载撞上失败，那句立刻上屏', async () => {
    let fail = false
    const stubs = {
      listKnowledgeBases: () => (fail ? { ok: false, error: REASON } : [KB]),
      listAvailableTools: () => [TOOL],
      listSkills: () => [SKILL]
    }
    // 首开：三发都读到，屏上零 alert
    const r1 = mount(stubs)
    await waitFor(() => expect(bodyText()).toContain('PROBE-知识库'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    r1.unmount()
    // 二开：同一根知识库通道改吐失败对象 ⇒ 那句必须重新出现（而不是 React 复用同一份 state 把上一份留下）
    fail = true
    mount(stubs)
    await waitFor(() => expect(alerts()).toEqual([FAILED(KB_WHAT, REASON)]), MOUNT_BUDGET)
    // 那一句"未创建"空态照旧要让位（同 §270 主用例的判据）
    expect(bodyText(), '把"读不到"演成"这台没建知识库"').not.toContain(L('ae.noKb'))
  })
})
