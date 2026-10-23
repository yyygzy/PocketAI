// @vitest-environment jsdom
// V4-Iter-268：输入框那圈六发**惰性清单读**——失败要逐发点名说一句，且各屏的出口形状按各屏自己有没有天然重发入口定。
//
// 闸门量出来的现数（`data/tmp/silent-42.json`）里这六处同一形状：`if (!hasIpcFailed(v)) 写进 ref/state`，
// 失败侧什么都不做 ⇒ @ 菜单里的知识库组、/ # 菜单里的用户片段组、上下文面板里的技能／知识库芯片**整组消失**，
// 屏上既不说"没读到"也不说"没有"（把通道故障演成"这里没东西"，§222 那一族的最后一种脸）。
//
// 重试键配不配，**按那一屏自己有没有天然入口**判（不是套模板）：
//  · 上下文面板那两发——再点那一格就是重发（`=== null` 那道守卫留着）⇒ 不加键；
//  · AgentComposer 的片段——失败时 ref 仍是 null ⇒ 退出再进触发态自己会重拉 ⇒ 不加键；
//  · 两个 Composer 的知识库——ref 被**占位写成 `[]`**（§221 量过：清回 null 会每次渲染重拉、输入框卡死转圈），
//    所以再打字也不会重拉 ⇒ 句子必须自带一颗重试键，否则那是句没出路的话。
import { describe, it, expect, beforeAll } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { ChatConfigBar } from '../src/renderer/src/modules/chat/ChatConfigBar'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { AgentComposer } from '../src/renderer/src/modules/agent/components/AgentComposer'
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

describe('① 上下文中枢面板（ChatConfigBar）：点开那一格读不到 ⇒ 那一格里说出是哪一格', () => {
  const assistant = { id: 'a1', name: 'a1', isBuiltin: false, skillIds: [], knowledgeBaseIds: [] } as unknown as AssistantRecord
  const mount = (over: Record<string, Impl> = {}): void => {
    stubPocketai({ listSkills: () => [SKILL], listKnowledgeBases: () => [KB], ...over })
    mountWithProviders(<ChatConfigBar assistant={assistant} onAssistantUpdated={() => { /* 本批不判写入 */ }} />)
  }
  const openContext = async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('ccb.context')) }))
    await settle()
  }

  it('技能那发挂 ⇒ 面板里只有「技能清单读不到」那一句（点开知识库那一格之前，另一句不许冒）', async () => {
    mount({ listSkills: () => FAIL })
    await openContext()
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.skillsList'), REASON)]), MOUNT_BUDGET)
    // 那一格此刻是空的（改前连「暂无可选项」都不出现）——句子替它把"为什么空"说了出来
    expect(screen.queryByText(L('ccb.none'))).toBeNull()
    expect(alerts()).toHaveLength(1)
  })

  it('知识库那发挂 ⇒ 说的是知识库；技能那发读到了 ⇒ 技能那句不许冒（一发挂不许替另一发闭嘴，也不许被合成一句）', async () => {
    mount({ listKnowledgeBases: () => FAIL })
    await openContext()
    // 先点开技能：这一发读到了 ⇒ 芯片摆出来、一句 alert 都不许有
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(screen.getByText('⚡ 技能一')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    // 再点开知识库：此刻面板显示的是知识库那一格（一次只显示一格），那句必须只点知识库的名
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^📚 ' + L('ccb.kb')) }))
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    expect(alerts().join(' ')).not.toContain(L('common.skillsList'))
  })

  it('reject 面 ⇒ 同一句、用的是抛出的原文（旧写法那条 `.catch(reportIpcError(...))` 屏上零字）', async () => {
    mount({ listSkills: () => Promise.reject(new Error('通道断了')) })
    await openContext()
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
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
    await openContext()
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.skillsList'), REASON)]), MOUNT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(callsOf('listSkills')).toBe(2), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    // 再点开那一格看芯片：读到之后守卫已关 ⇒ 不会再拉第三次（次数这条断言就是钉这一点的）
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(screen.getByText('⚡ 技能一')).toBeTruthy(), MOUNT_BUDGET)
    expect(screen.getByText('⚡ 技能一')).toBeTruthy()
    expect(callsOf('listSkills')).toBe(2)
    // 这一处**没有**自造的重试键（那一格本身就是出口）
    expect(screen.queryByTestId('composer-kbs-retry')).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 一个 alert 都没有，芯片照常摆', async () => {
    mount()
    await openContext()
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^⚡ ' + L('ccb.skills')) }))
    await waitFor(() => expect(screen.getByText('⚡ 技能一')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: new RegExp('^📚 ' + L('ccb.kb')) }))
    await waitFor(() => expect(screen.getByText('📚 库一')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})

describe('② 对话页输入框（Composer）：两发的 ref 都被占位写死 ⇒ 两句各自自带重试键', () => {
  const props = { streaming: false, canSend: true, noModels: false, onSend: () => { /* 本批不判发送 */ }, onStop: () => { /* 同上 */ }, draftKey: 'c1' }
  // SnippetButton 里还有一个 textbox ⇒ 不用 getByRole，取 Composer 自己标的 data-chat-composer-input
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

describe('③ Agent 输入框（AgentComposer）：同一颗知识库那句自带键', () => {
  const att = {
    attachments: [],
    dragOver: false,
    addFiles: () => { /* 本批不判附件 */ },
    addAttachment: () => { /* 同上 */ },
    removeAt: () => { /* 同上 */ },
    clear: () => { /* 同上 */ },
    openPicker: () => { /* 同上 */ },
    fileInputProps: {},
    dropZoneProps: {},
    pasteProps: {}
  }
  const props = {
    running: false,
    canSend: true,
    att: att as unknown as Parameters<typeof AgentComposer>[0]['att'],
    onSend: () => { /* 本批不判发送 */ },
    onAbort: () => { /* 同上 */ },
    queue: [],
    queueFull: false,
    onQueue: () => { /* 同上 */ },
    onInterject: () => { /* 同上 */ },
    onDropQueued: () => { /* 同上 */ },
    onSendQueuedNow: () => { /* 同上 */ }
  }
  const type = (v: string): void => {
    fireEvent.change(document.querySelector('[data-agent-composer-input]') as Element, { target: { value: v } })
  }
  const mount = (over: Record<string, Impl> = {}): void => {
    stubPocketai({ listKnowledgeBases: () => [KB], listPromptSnippets: () => [SNIPPET], ...over })
    mountWithProviders(<AgentComposer {...props} />)
  }

  it('知识库那发挂 ⇒ 那句＋键；点它成功 ⇒ 退场且通道共两次', async () => {
    let first = true
    mount({
      listKnowledgeBases: () => {
        if (first) { first = false; return FAIL }
        return [KB]
      }
    })
    type('@')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    fireEvent.click(screen.getByTestId('agent-composer-kbs-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(callsOf('listKnowledgeBases')).toBe(2)
  })

  it('片段那发挂 ⇒ 那句在、没有键（这一屏的出口是"退出再进触发态"）', async () => {
    mount({ listPromptSnippets: () => FAIL })
    type('/')
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.snippetList'), REASON)]), MOUNT_BUDGET)
    expect(screen.queryByTestId('agent-composer-kbs-retry')).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 零 alert，斜杠菜单里片段照常摆', async () => {
    mount()
    type('/')
    await waitFor(() => expect(screen.getByText('#探针片段')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})
