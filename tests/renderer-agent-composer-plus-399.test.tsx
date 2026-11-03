// @vitest-environment jsdom
// V4-Iter-399①：Agent 输入框左端那两颗平铺键（📎／）收成一颗「+」，菜单里三行**接的全是已有的出口**。
//
// 这枚的口径＝**零行为变化**：附件仍是 `att.openPicker`、片段仍是 `SnippetButton` 那套三态弹层、
// 知识库仍是同一发 `listKnowledgeBases` 惰性读＋同一颗 kb chip（不另起第二份清单机关）。
// 判据挑的四件事：
//   ① 入口收成一颗（未点开时输入行里不该再有那两颗平铺键）；
//   ② 三行各自接的出口真的接上了（openPicker／片段插入／addAttachment 的载荷逐值核）；
//   ③ 「清单读不到」那张脸**不搬进浮层**——菜单里既不说"暂无可选项"也不说"还在加载"，
//      说话的是浮层外面那句既有的（§268：菜单一关就不说话＝替这次失败闭嘴）；
//   ④ 收合：Esc 与点外部都收得掉；运行中附件与片段两行禁用、知识库行仍可挑。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import React from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentComposer } from '../src/renderer/src/modules/agent/components/AgentComposer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, PromptSnippetRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const REASON = 'KB_DIR_LOCKED:库被占用'
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
/** 让那一发惰性读的 `.then` 与紧随的那次渲染都落定（§330 那条：`act(async)` 只刷一层微任务） */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const KB = { id: 'k1', name: '库一', description: 'd', documentCount: 3 } as unknown as KnowledgeBase
const KB2 = { id: 'k2', name: '库二', description: 'd', documentCount: 12 } as unknown as KnowledgeBase
const SNIPPET = { id: 'p1', title: '探针片段', content: 'hello {{who}}' } as unknown as PromptSnippetRecord
const SNIPPET_PLAIN = { id: 'p2', title: '直插片段', content: 'plain-text' } as unknown as PromptSnippetRecord

// jsdom 没有布局：菜单项高亮会调 scrollIntoView，不补就留 Unhandled Errors（§221 同一条）
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* 空操作 */
  }
})

const openPicker = vi.fn()
const addAttachment = vi.fn()

// 这两颗是模块级的 `vi.fn`：逐例清零，否则"恰好一次"那种判据会被上一例的账喂绿
beforeEach(() => {
  openPicker.mockClear()
  addAttachment.mockClear()
})

function props(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    running: false,
    canSend: true,
    att: {
      attachments: [],
      dragOver: false,
      addFiles: () => {},
      addAttachment,
      removeAt: () => {},
      clear: () => {},
      openPicker,
      fileInputProps: {},
      dropZoneProps: {},
      pasteProps: {}
    },
    onSend: () => {},
    onAbort: () => {},
    queue: [],
    queueFull: false,
    onQueue: () => {},
    onInterject: () => {},
    onDropQueued: () => {},
    onSendQueuedNow: () => {},
    ...over
  }
}

/** `over`＝通道桩的覆盖；`pOver`＝组件 props 的覆盖（两件事别混：`running` 不是通道） */
function mount(over: Record<string, unknown> = {}, pOver: Record<string, unknown> = {}): void {
  stubPocketai({
    listKnowledgeBases: () => [KB, KB2],
    listPromptSnippets: () => [SNIPPET, SNIPPET_PLAIN],
    ...over
  })
  mountWithProviders(React.createElement(AgentComposer, props(pOver) as never))
}

const plus = (): HTMLElement => screen.getByTestId('agent-composer-plus')
const menu = (): HTMLElement | null => screen.queryByTestId('agent-composer-plus-menu')
const openPlus = async (): Promise<void> => {
  fireEvent.click(plus())
  await waitFor(() => expect(menu()).not.toBeNull(), MOUNT_BUDGET)
}

describe('① 入口收成一颗', () => {
  it('未点开：只有那颗「+」，输入行里不许再躺着平铺的附件键与片段键', () => {
    mount()
    expect(plus()).toBeTruthy()
    expect(menu()).toBeNull()
    // 那两颗键的 title 都来自既有键——菜单没开时它们不该在屏上
    expect(screen.queryByTitle(L('common.attachFile'))).toBeNull()
    expect(screen.queryByTitle(L('snippet.button'))).toBeNull()
  })

  it('点开：三行齐（附件／片段／知识库那一组），逐值取字典不手抄', async () => {
    mount()
    await openPlus()
    expect(screen.getByTestId('agent-composer-plus-file').textContent).toContain(L('common.attachFile'))
    expect(screen.getByText(L('snippet.button'))).toBeTruthy()
    expect(screen.getByText(L('mention.knowledge'))).toBeTruthy()
    // 知识库那一组摆的是同一份清单（名字＋篇数用的是既有的那颗 `common.docs`）
    expect(screen.getByTestId('agent-composer-plus-kb-k1').textContent).toContain('库一')
    expect(screen.getByTestId('agent-composer-plus-kb-k1').textContent).toContain(`3 ${L('common.docs')}`)
    expect(screen.getByTestId('agent-composer-plus-kb-k2').textContent).toContain('库二')
  })
})

describe('② 三行接的都是已有的出口', () => {
  it('点附件行⇒ 只调 `openPicker` 一次并把菜单收掉（不发任何新通道）', async () => {
    mount()
    await openPlus()
    fireEvent.click(screen.getByTestId('agent-composer-plus-file'))
    expect(openPicker).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
  })

  it('点片段行⇒ 弹的是片段自己那套三态；挑「直插片段」把正文插进输入框并收掉整层', async () => {
    mount()
    await openPlus()
    fireEvent.click(screen.getByText(L('snippet.button')))
    await waitFor(() => expect(screen.getByText('直插片段')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.click(screen.getByText('直插片段'))
    await waitFor(() => {
      expect((screen.getByTitle(L('agent.composerTitle')) as HTMLTextAreaElement).value).toContain('plain-text')
      expect(menu()).toBeNull()
    }, MOUNT_BUDGET)
  })

  it('按真机的顺序（先 mousedown 再 click）点菜单项⇒ 那一行照样执行（点自己那一层不算"点外部"）', async () => {
    mount()
    await openPlus()
    const row = screen.getByTestId('agent-composer-plus-file')
    fireEvent.mouseDown(row)
    expect(menu(), 'mousedown 那一刻就把面板关掉＝紧随的 click 落在空气上').not.toBeNull()
    fireEvent.click(row)
    expect(openPicker).toHaveBeenCalledTimes(1)
  })

  it('点知识库行⇒ 追加的是同一颗 kb chip（载荷逐值核），并收掉菜单', async () => {
    mount()
    await openPlus()
    fireEvent.click(screen.getByTestId('agent-composer-plus-kb-k2'))
    expect(addAttachment).toHaveBeenCalledTimes(1)
    expect(addAttachment.mock.calls[0]?.[0]).toMatchObject({ type: 'kb', name: '库二', kbId: 'k2' })
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
  })
})

describe('③ 「读不到」那张脸不搬进浮层（§268 那条口径）', () => {
  it('那一发失败⇒ 菜单里既不说"暂无可选项"也不说"还在加载"；说话的是浮层外面那句＋那颗键', async () => {
    mount({ listKnowledgeBases: () => ({ ok: false, error: REASON }) })
    await openPlus()
    await settle()
    const panel = menu() as HTMLElement
    expect(panel.textContent, '菜单里不许把"读不到"演成"这里没东西"').not.toContain(L('ccb.none'))
    expect(panel.textContent).not.toContain('…')
    // 外面那句既有的（带清单名＋原因）与那颗重试键都在，且都不在菜单里
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    expect(screen.getByTestId('agent-composer-kbs-retry')).toBeTruthy()
    expect((panel.querySelector('[data-testid="agent-composer-kbs-retry"]'))).toBeNull()
  })

  it('反向对照：读到了⇒ 外面一句都不许有，菜单里照常摆两本库', async () => {
    mount()
    await openPlus()
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.getByTestId('agent-composer-plus-kb-k1')).toBeTruthy()
    expect(screen.getByTestId('agent-composer-plus-kb-k2')).toBeTruthy()
  })

  it('库里真的没有东西（读成功、零本）⇒ 菜单里才说"暂无可选项"（那一档不是失败的替身）', async () => {
    mount({ listKnowledgeBases: () => [] })
    await openPlus()
    await settle()
    expect(alerts(), '读成功⇒ 那句读不到不许冒').toEqual([])
    expect((menu() as HTMLElement).textContent).toContain(L('ccb.none'))
  })
})

describe('④ 收合与运行中', () => {
  it('Esc 收掉整层；再点那颗键又开（入口不是单向的）', async () => {
    mount()
    await openPlus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
    fireEvent.click(plus())
    await waitFor(() => expect(menu()).not.toBeNull(), MOUNT_BUDGET)
  })

  it('Esc 落在片段那一层里⇒只收那一层，外层「+」菜单还在（不越级把整层关掉）', async () => {
    mount()
    await openPlus()
    fireEvent.click(screen.getByText(L('snippet.button')))
    await waitFor(() => expect(screen.getByText('直插片段')).toBeTruthy(), MOUNT_BUDGET)
    fireEvent.keyDown(screen.getByText('直插片段'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('直插片段')).toBeNull(), MOUNT_BUDGET)
    expect(menu(), '外层菜单不该被那一层的 Esc 顺带关掉').not.toBeNull()
  })

  it('点菜单外面⇒ 收（点那颗键本身不算"外面"，它是开合开关）', async () => {
    mount()
    await openPlus()
    fireEvent.mouseDown(screen.getByTitle(L('agent.composerTitle')))
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
  })

  it('运行中：附件与片段两行禁用（排队只带文字），知识库那一行仍可挑', async () => {
    mount({}, { running: true })
    await openPlus()
    expect((screen.getByTestId('agent-composer-plus-file') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('agent-composer-plus-file').getAttribute('title')).toBe(L('agent.queue.textOnly'))
    expect(
      (screen.getByTitle(L('snippet.button')) as HTMLButtonElement).disabled
    ).toBe(true)
    expect((screen.getByTestId('agent-composer-plus-kb-k1') as HTMLButtonElement).disabled).toBe(false)
  })
})
