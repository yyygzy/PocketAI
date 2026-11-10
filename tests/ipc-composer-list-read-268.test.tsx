// @vitest-environment jsdom
// V4 交互改造后，技能/知识库从「⚙ 上下文」面板搬进输入区「+」菜单：
// 失败句仍然必须在**浮层外**（浮层一关句子就没了＝替这次失败闭嘴），再点那一格就是重发。
import { describe, it, expect, beforeAll } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  AssistantRecord,
  KnowledgeBase,
  PromptSnippetRecord,
  SkillRecord
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (what: string, msg: string): string => L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const REASON = 'KB_DIR_LOCKED:库被占用'
const FAIL = { ok: false, error: REASON }

// jsdom 没有布局：两个菜单在 activeIndex 变化时会调 scrollIntoView，不补就留 Unhandled Errors（§221 同一条）
beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* 空操作 */ }
})

const SKILL = { id: 's1', name: '技能一', icon: '⚡', description: 'd' } as unknown as SkillRecord
const KB = { id: 'k1', name: '库一', description: 'd', documentCount: 3 } as unknown as KnowledgeBase
const SNIPPET = { id: 'p1', title: '探针片段', content: 'hello' } as unknown as PromptSnippetRecord

type Impl = (...a: unknown[]) => unknown

describe('① 「+ → 技能/知识库」：读不到 ⇒ 句子在输入框上方，浮层里不放失败提示', () => {
  const assistant = { id: 'a1', name: 'a1', isBuiltin: false, skillIds: [], knowledgeBaseIds: [] } as unknown as AssistantRecord
  const props = {
    streaming: false,
    canSend: true,
    onSend: () => { /* 本批不判发送 */ },
    onStop: () => { /* 同上 */ },
    draftKey: 'c1',
    assistant,
    onAssistantUpdated: () => { /* 本批不判写入 */ }
  }
  const mount = (over: Record<string, Impl> = {}): void => {
    stubPocketai({ listSkills: () => [SKILL], listKnowledgeBases: () => [KB], listPromptSnippets: () => [], ...over })
    mountWithProviders(<Composer {...props} />)
  }
  const openPlus = (): void => {
    fireEvent.click(screen.getByTestId('composer-plus-open'))
  }
  const openSkills = async (): Promise<void> => {
    openPlus()
    fireEvent.click(screen.getByTestId('composer-plus-skills'))
    await settle()
  }
  const backToMain = (): void => {
    // 返回键的文字是 aria-hidden 的 ‹ ⇒ 可访问名就是二级页标题（芯片名带图标前缀，不会撞）
    fireEvent.click(screen.getByRole('button', { name: L('ccb.skills') }))
  }
  // 失败句不许进浮层：浮层一关句子就没了＝替这次失败闭嘴
  const menuAlerts = (): number =>
    screen.getByTestId('composer-plus-menu').querySelectorAll('[role="alert"]').length

  it('技能那发挂 ⇒ 输入框上方只有「技能清单读不到」那一句，浮层里零 alert', async () => {
    mount({ listSkills: () => FAIL })
    await openSkills()
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.skillsList'), REASON)]), MOUNT_BUDGET)
    // 那一格此刻是空的（改前连「暂无可选项」都不出现）——句子替它把"为什么空"说了出来
    expect(screen.queryByText(L('ccb.none'))).toBeNull()
    expect(alerts()).toHaveLength(1)
    expect(menuAlerts()).toBe(0)
  })

  it('知识库那发挂 ⇒ 说的是知识库；技能那发读到了 ⇒ 技能那句不许冒（一发挂不许替另一发闭嘴，也不许被合成一句）', async () => {
    mount({ listKnowledgeBases: () => FAIL })
    await openSkills()
    // 先点开技能：这一发读到了 ⇒ 芯片摆出来、一句 alert 都不许有
    await waitFor(() => expect(screen.getByText('⚡ 技能一')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    // 再切到知识库那一页：那句必须只点知识库的名
    backToMain()
    fireEvent.click(screen.getByTestId('composer-plus-kb'))
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    expect(alerts().join(' ')).not.toContain(L('common.skillsList'))
    expect(menuAlerts()).toBe(0)
  })

  it('reject 面 ⇒ 同一句、用的是抛出的原文（旧写法那条 `.catch(reportIpcError(...))` 屏上零字）', async () => {
    mount({ listSkills: () => Promise.reject(new Error('通道断了')) })
    await openSkills()
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.skillsList'), '通道断了')]), MOUNT_BUDGET)
  })

  it('再点那一格就是重发（不另配重试键）：这回落成功 ⇒ 那句退场、芯片上屏，且通道共两次', async () => {
    let first = true
    mount({
      listSkills: () => {
        if (first) { first = false; return FAIL }
        return [SKILL]
      }
    })
    await openSkills()
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.skillsList'), REASON)]), MOUNT_BUDGET)
    // 关掉「+」再打开 ⇒ 回到首层；再点技能那一格＝重发这一发
    openPlus()
    openPlus()
    fireEvent.click(screen.getByTestId('composer-plus-skills'))
    await waitFor(() => expect(callsOf('listSkills'), '点那一格＝重发这一发').toBe(2), MOUNT_BUDGET)
    // 芯片上屏之后一起判：那一帧才是"落定了、且横幅随之退场"
    await waitFor(() => {
      expect(screen.getByText('⚡ 技能一'), '读到 ⇒ 芯片上屏').toBeTruthy()
      expect(alerts(), '那句随之退场').toEqual([])
    }, MOUNT_BUDGET)
    expect(callsOf('listSkills')).toBe(2)
    // 这一处**没有**自造的重试键（那一格本身就是出口）
    expect(screen.queryByTestId('composer-kbs-retry')).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 一个 alert 都没有，芯片照常摆', async () => {
    mount()
    await openSkills()
    await waitFor(() => expect(screen.getByText('⚡ 技能一')).toBeTruthy(), MOUNT_BUDGET)
    backToMain()
    fireEvent.click(screen.getByTestId('composer-plus-kb'))
    await waitFor(() => expect(screen.getByText('📚 库一')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

describe('② 对话页输入框（Composer）：两发的 ref 都被占位写死 ⇒ 两句各自自带重试键', () => {
  const props = { streaming: false, canSend: true, noModels: false, onSend: () => { /* 本批不判发送 */ }, onStop: () => { /* 同上 */ }, draftKey: 'c1' }
  // 输入框自己带 data-chat-composer-input 标记 ⇒ 不用 getByRole 猜 textbox
  const type = (v: string): void => {
    fireEvent.change(document.querySelector('[data-chat-composer-input]') as Element, { target: { value: v } })
  }
  const mount = (over: Record<string, Impl> = {}): void => {
    stubPocketai({ listKnowledgeBases: () => [KB], listPromptSnippets: () => [SNIPPET], ...over })
    mountWithProviders(<Composer {...props} />)
  }

  it('知识库那发挂 ⇒ 「知识库清单读不到」＋一颗重试键；没碰片段 ⇒ 片段那句不许冒', async () => {
    mount({ listKnowledgeBases: () => FAIL })
    type('@')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    expect(screen.getByTestId('composer-kbs-retry')).toBeTruthy()
    expect(alerts()).toHaveLength(1)
  })

  it('点那颗键 ⇒ 真的再发一次并成功：那句退场、菜单里有了那个库（键不是摆设）', async () => {
    let first = true
    mount({
      listKnowledgeBases: () => {
        if (first) { first = false; return FAIL }
        return [KB]
      }
    })
    type('@')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    fireEvent.click(screen.getByTestId('composer-kbs-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(callsOf('listKnowledgeBases')).toBe(2)
  })

  it('片段那发挂 ⇒ 那句＋键在；点它才重拉（这一处 ref 失败前已被占位写成 []，再打字不会自己重拉）', async () => {
    mount({ listPromptSnippets: () => FAIL })
    type('#')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.snippetList'), REASON)]), MOUNT_BUDGET)
    expect(screen.getByTestId('composer-snippets-retry')).toBeTruthy()
    // §221 那条规矩仍然守着：不点键就只拉一次（失败绝不把 ref 清回 null）
    expect(callsOf('listPromptSnippets')).toBe(1)
    fireEvent.click(screen.getByTestId('composer-snippets-retry'))
    await waitFor(() => expect(callsOf('listPromptSnippets')).toBe(2), MOUNT_BUDGET)
  })

  it('反向对照：两发都读到 ⇒ 一个 alert 都没有（那句不是常驻装饰）', async () => {
    mount()
    type('#')
    await waitFor(() => expect(screen.getByText('#探针片段')).toBeTruthy(), MOUNT_BUDGET)
    type('@')
    await waitFor(() => expect(callsOf('listKnowledgeBases')).toBeGreaterThan(0), MOUNT_BUDGET)
    await settle()
    expect(alerts()).toEqual([])
  })

  it('两发各挂各的 ⇒ 两句同时在场、各点各的名（不是合成一句"清单读不到"）', async () => {
    mount({ listKnowledgeBases: () => FAIL, listPromptSnippets: () => Promise.reject(new Error('片段通道断了')) })
    type('@')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    type('#')
    await waitFor(() => expect(alerts().length).toBe(2), MOUNT_BUDGET)
    expect(alerts()).toContain(FAILED(L('common.kbList'), REASON))
    expect(alerts()).toContain(FAILED(L('common.snippetList'), '片段通道断了'))
  })
})

