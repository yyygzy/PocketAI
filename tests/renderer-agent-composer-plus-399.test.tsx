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
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { agentToolsStub, mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentComposer } from '../src/renderer/src/modules/agent/components/AgentComposer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, PromptSnippetRecord, ShellConfig } from '../src/shared/types'

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
// §399②a：那两项搬进来的四个出口——按"发没发、发的什么"判，不靠读屏猜
const toggleTextProtocol = vi.fn()
const retryTextProtocol = vi.fn()
const pickWorkspace = vi.fn()
const retryWorkspace = vi.fn()

// 这些是模块级的 `vi.fn`：逐例清零，否则"恰好一次"那种判据会被上一例的账喂绿
beforeEach(() => {
  openPicker.mockClear()
  addAttachment.mockClear()
  toggleTextProtocol.mockClear()
  retryTextProtocol.mockClear()
  pickWorkspace.mockClear()
  retryWorkspace.mockClear()
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
    // §399②a：搬进来的这两项。默认摆"读到了、且没走文本协议、也没设目录"那一档（三档都由下面的用例逐张演）
    textProtocolAvailable: true,
    textProtocolForced: false,
    textProtocolUnread: null,
    onToggleTextProtocol: toggleTextProtocol,
    onRetryTextProtocol: retryTextProtocol,
    workspaceDir: '',
    workspaceUnread: null,
    onPickWorkspace: pickWorkspace,
    onRetryWorkspace: retryWorkspace,
    tools: agentToolsStub(),
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

describe('⑤ 顶栏那两颗徽标搬进菜单（§399②a 第一半：入口搬家，脸一个字没改）', () => {
  it('菜单里两行齐：文本协议按「没走」那一脸、工作目录按「未设置」那一脸（名字逐字取字典）', async () => {
    mount()
    await openPlus()
    const tp = screen.getByTestId('agent-composer-plus-text-protocol')
    expect(tp.textContent).toContain(L('agent.textProtocol'))
    expect(tp.getAttribute('aria-checked')).toBe('false')
    expect(tp.getAttribute('title')).toBe(L('agent.textProtocolHint'))
    const ws = screen.getByTestId('agent-composer-plus-workspace')
    expect(ws.textContent).toContain(L('agent.workspaceNone'))
    expect(ws.getAttribute('title')).toBe(L('agent.workspacePickTip'))
    // 反向对照：这两行不是"已启用／已设置"的替身
    expect(screen.queryByText(L('agent.textProtocolOn'))).toBeNull()
  })

  it('点文本协议那行⇒ 传的是取反后的目标状态（关着点 true），且菜单不收（这一发的写是异步的）', async () => {
    mount()
    await openPlus()
    const tp = screen.getByTestId('agent-composer-plus-text-protocol')
    fireEvent.click(tp)
    expect(toggleTextProtocol).toHaveBeenCalledTimes(1)
    expect(toggleTextProtocol).toHaveBeenLastCalledWith(true)
    expect(menu(), '点了开关就收菜单＝要再点一次才看得见那张脸翻过去').not.toBeNull()
  })

  it('已启用那一档：行上是「文本协议已启用」＋aria-checked=true＋悬停讲"点击关闭"，点下去传 false', async () => {
    mount({}, { textProtocolForced: true })
    await openPlus()
    const on = screen.getByTestId('agent-composer-plus-text-protocol')
    expect(on.getAttribute('aria-checked')).toBe('true')
    expect(on.textContent).toContain(L('agent.textProtocolOn'))
    expect(on.getAttribute('title')).toBe(L('agent.textProtocolOnHint'))
    fireEvent.click(on)
    expect(toggleTextProtocol).toHaveBeenCalledTimes(1)
    expect(toggleTextProtocol).toHaveBeenLastCalledWith(false)
  })

  it('点工作目录那行⇒ 只调 onPickWorkspace 一次并把菜单收掉（挑目录是本机对话框，不是又一发通道）', async () => {
    mount()
    await openPlus()
    fireEvent.click(screen.getByTestId('agent-composer-plus-workspace'))
    expect(pickWorkspace).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
  })

  it('工作目录读得到⇒ 行上是末段目录名、悬停是全路径；读到空串才是「未设置」', async () => {
    mount({}, { workspaceDir: 'C:/Users/x/proj-beta' })
    await openPlus()
    const ws = screen.getByTestId('agent-composer-plus-workspace')
    expect(ws.textContent).toContain('proj-beta')
    expect(ws.getAttribute('title')).toBe('C:/Users/x/proj-beta')
    expect(screen.queryByText(L('agent.workspaceNone'))).toBeNull()
  })

  it('工作目录读不到⇒ 行上写「工作目录取不到」＋悬停带原因，「未设置」一个字都不许摆（§257 那张谎脸）', async () => {
    mount({}, { workspaceUnread: 'WS_DIR:库被占用' })
    await openPlus()
    const bad = screen.getByTestId('agent-composer-plus-workspace')
    expect(bad.textContent).toContain(L('agent.workspaceReadFail'))
    expect(bad.getAttribute('title')).toContain('WS_DIR:库被占用')
    expect(screen.queryByText(L('agent.workspaceNone')), '默认字面量冒充读数').toBeNull()
  })

  it('文本协议读不到⇒ 那一行既不是「文本协议」也不是「文本协议已启用」，直说取不到，悬停带原因', async () => {
    mount({}, { textProtocolUnread: 'TP:清单取不到', textProtocolForced: true })
    await openPlus()
    const tp = screen.getByTestId('agent-composer-plus-text-protocol')
    expect(tp.textContent).toContain(L('agent.textProtocolReadFail'))
    expect(tp.getAttribute('title')).toContain('TP:清单取不到')
    expect(screen.queryByText(L('agent.textProtocol'))).toBeNull()
    expect(screen.queryByText(L('agent.textProtocolOn'))).toBeNull()
  })

  it('还没选到模型⇒ 不给那颗能点的开关（作用域是 provider+model），但工作目录那行照常在', async () => {
    mount({}, { textProtocolAvailable: false })
    await openPlus()
    expect(screen.queryByTestId('agent-composer-plus-text-protocol')).toBeNull()
    expect(screen.getByTestId('agent-composer-plus-workspace')).toBeTruthy()
  })
})

describe('⑥ 升级回显（§399②a 第二半：常态一颗徽标，坏消息时才就地长出那句）', () => {
  const danger = (): boolean => (plus().getAttribute('class') ?? '').includes('text-[var(--color-danger)]')

  it('常态（四项都读到了）：徽标不带危险色，输入区一句「读不到」都没有', async () => {
    mount()
    expect(danger(), '没坏消息时不许常驻一行摘要').toBe(false)
    expect(alerts()).toEqual([])
    await openPlus()
    expect(alerts()).toEqual([])
  })

  it('工作目录那一读失败⇒ 徽标转危险色＋浮层外长出那句与同级重试键；点它只发那一次重读出口', async () => {
    mount({}, { workspaceUnread: 'WS_DIR:库被占用' })
    await waitFor(() => expect(alerts()).toEqual([L('agent.workspaceUnread')]), MOUNT_BUDGET)
    expect(danger(), '坏消息时那颗徽标要点名').toBe(true)
    const line = screen.getByText(L('agent.workspaceUnread'))
    expect(line.getAttribute('title'), '原因挂在悬停上（这一句本体是既有的那张脸）').toBe('WS_DIR:库被占用')
    const panel = menu()
    expect(panel, '没点菜单时那句就该在屏上（藏在浮层后面＝替这次失败闭嘴）').toBeNull()
    fireEvent.click(screen.getByTestId('agent-composer-workspace-retry'))
    expect(retryWorkspace).toHaveBeenCalledTimes(1)
    expect(pickWorkspace, '重试是重读那一发，不是又开一次本机对话框').toHaveBeenCalledTimes(0)
  })

  it('文本协议那一读失败⇒ 同一形状：那句（既有那张 title）＋那颗键，且菜单里那一行也只说取不到', async () => {
    mount({}, { textProtocolUnread: 'TP:清单取不到' })
    await waitFor(() => expect(alerts()).toEqual([L('agent.textProtocolUnread')]), MOUNT_BUDGET)
    expect(danger()).toBe(true)
    expect(screen.getByText(L('agent.textProtocolUnread')).getAttribute('title')).toBe('TP:清单取不到')
    await openPlus()
    expect(screen.getByTestId('agent-composer-plus-text-protocol').textContent).toContain(L('agent.textProtocolReadFail'))
    fireEvent.click(screen.getByTestId('agent-composer-text-protocol-retry'))
    expect(retryTextProtocol).toHaveBeenCalledTimes(1)
  })

  it('知识库那一读失败（①就有的那两句之一）⇒ 现在也被这颗徽标点名；菜单收掉之后那句还在', async () => {
    mount({ listKnowledgeBases: () => ({ ok: false, error: REASON }) })
    await openPlus()
    await settle()
    await waitFor(() => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)]), MOUNT_BUDGET)
    expect(danger()).toBe(true)
    // 收合不算消失：那句与那颗键都不在菜单里，菜单关了它们还在
    expect((menu() as HTMLElement).querySelector('[data-testid="agent-composer-kbs-retry"]')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
    expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON)])
    expect(screen.getByTestId('agent-composer-kbs-retry')).toBeTruthy()
  })

  it('两项同时读不到⇒ 两句各成一行（不合并、不互相挂靠），徽标只一颗转色', async () => {
    mount({ listKnowledgeBases: () => ({ ok: false, error: REASON }) }, { workspaceUnread: 'WS_DIR:库被占用' })
    await openPlus()
    await settle()
    await waitFor(
      () => expect(alerts()).toEqual([FAILED(L('common.kbList'), REASON), L('agent.workspaceUnread')]),
      MOUNT_BUDGET
    )
    expect(danger()).toBe(true)
  })
})

describe('⑦ 工具策略那一行与它的嵌套第二层（§399②b）', () => {
  const toolsMenu = (): HTMLElement | null => screen.queryByTestId('agent-composer-tools-menu')
  const toolsRow = (): HTMLElement => screen.getByTestId('agent-composer-plus-tools')
  const openTools = async (): Promise<void> => {
    await openPlus()
    fireEvent.click(toolsRow())
    await waitFor(() => expect(toolsMenu()).not.toBeNull(), MOUNT_BUDGET)
  }
  const DEFAULTS = (what: string, msg: string): string =>
    L('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)
  const threeUnread = (): Record<string, unknown> => ({
    tools: agentToolsStub({
      toolUnread: { workspace: null, shell: 'S:终端清单取不到', webSearch: 'W:渠道取不到', calendar: 'C:日历取不到' }
    })
  })
  const dangerNow = (): boolean =>
    (screen.getByTestId('agent-composer-plus').getAttribute('class') ?? '').includes('text-[var(--color-danger)]')

  it('两层都没开⇒ 那三行控件不在屏上（消息流之上那条常驻折叠条从此没有第二份脸）', () => {
    mount()
    expect(toolsMenu()).toBeNull()
    expect(screen.queryAllByRole('checkbox'), '控件只住在那一层里').toEqual([])
  })

  it('点那一行⇒ 长出第二层、三行齐；外层「+」菜单同时还在，那一行的悬停翻成「收起」', async () => {
    mount()
    await openTools()
    expect(menu(), '那一层嵌在外层里面，不是把外层顶掉').not.toBeNull()
    expect(within(toolsMenu() as HTMLElement).getAllByRole('checkbox')).toHaveLength(3)
    expect(toolsRow().getAttribute('title')).toBe(L('agent.collapse'))
    expect(toolsRow().getAttribute('aria-expanded')).toBe('true')
  })

  it('再点那一行⇒ 只收那一层，外层菜单留着（不是"点一下把两层一起关掉"）', async () => {
    mount()
    await openTools()
    fireEvent.click(toolsRow())
    await waitFor(() => expect(toolsMenu()).toBeNull(), MOUNT_BUDGET)
    expect(menu()).not.toBeNull()
  })

  it('Esc 在那一层里⇒只收那一层；外层菜单要再按一次才收（不越级，也不变成哑键）', async () => {
    mount()
    await openTools()
    fireEvent.keyDown(toolsMenu() as HTMLElement, { key: 'Escape' })
    await waitFor(() => expect(toolsMenu()).toBeNull(), MOUNT_BUDGET)
    expect(menu(), '外层不该被内层的 Esc 顺带关掉').not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
  })

  it('点内层之外、但还在外层菜单里（知识库那行标题）⇒ 只收内层', async () => {
    mount()
    await openTools()
    fireEvent.mouseDown(screen.getByText(L('mention.knowledge')))
    await waitFor(() => expect(toolsMenu()).toBeNull(), MOUNT_BUDGET)
    expect(menu()).not.toBeNull()
  })

  it('点真正的外部（输入框）⇒ 两层一起收；重开「+」时那一层不残留成开着', async () => {
    mount()
    await openTools()
    fireEvent.mouseDown(screen.getByTitle(L('agent.composerTitle')))
    await waitFor(() => expect(menu()).toBeNull(), MOUNT_BUDGET)
    expect(toolsMenu()).toBeNull()
    fireEvent.click(screen.getByTestId('agent-composer-plus'))
    await waitFor(() => expect(menu()).not.toBeNull(), MOUNT_BUDGET)
    expect(toolsMenu(), 'toolsOpen 留在 true＝重开直接摊开那三行，与"点一下才展开"相反').toBeNull()
  })

  it('密钥确认弹窗里点一下不算"点浮层外面"⇒ 两层都不收（点确认就关层＝这发永远确认不完）', async () => {
    mount(
      {},
      {
        tools: agentToolsStub({
          secretDialog: React.createElement(
            'div',
            { role: 'dialog', 'data-testid': 'stub-secret-dialog' },
            React.createElement('button', { 'data-testid': 'stub-secret-confirm' }, '确认')
          )
        })
      }
    )
    await openTools()
    expect(screen.getByTestId('stub-secret-dialog')).toBeTruthy()
    const btn = screen.getByTestId('stub-secret-confirm')
    fireEvent.mouseDown(btn)
    fireEvent.click(btn)
    expect(toolsMenu(), '内层不该被这一下关掉').not.toBeNull()
    expect(menu(), '外层更不该').not.toBeNull()
  })

  it('摘要行点的是"开着哪几项"：开了终端与联网就点🖥🌐，没开日历就不点📅', async () => {
    mount(
      {},
      {
        tools: agentToolsStub({
          shellConfig: { enabled: true, policy: 'confirm' },
          wsConfig: { enabled: true, provider: 'tavily', apiKey: '', hasKey: false }
        })
      }
    )
    await openPlus()
    const row = toolsRow().textContent ?? ''
    expect(row).toContain('🖥')
    expect(row).toContain('🌐')
    expect(row, '日历没开就不点📅').not.toContain('📅')
  })

  it('三项全关着⇒ 那一行只念一次「工具配置」（旧折叠条的 `summary || t(...)` 会念成「工具配置 工具配置」）', async () => {
    mount()
    await openPlus()
    const off = toolsRow().textContent ?? ''
    expect(off).toContain(L('agent.toolConfig'))
    expect(off.split(L('agent.toolConfig')).length - 1, '「工具配置」在这行上只出现一次').toBe(1)
    expect(off).not.toContain('🖥')
  })

  it('在那一层里勾终端开关⇒ `patchShellConfig` 收到 {enabled:true}（控件真接上，不是画出来的死控件）', async () => {
    const patchShellConfig = vi.fn(async (_patch: Partial<ShellConfig>): Promise<void> => {
      /* 只数被调与载荷，写本身由 §256 那族用例判 */
    })
    mount({}, { tools: agentToolsStub({ patchShellConfig }) })
    await openTools()
    const box = within(toolsMenu() as HTMLElement).getAllByRole('checkbox')[0] as HTMLInputElement
    fireEvent.click(box)
    expect(patchShellConfig).toHaveBeenCalledTimes(1)
    expect(patchShellConfig.mock.calls[0]?.[0]).toEqual({ enabled: true })
  })

  it('工具那三发读不到⇒ 徽标转危险色＋三句各成一行住在浮层**外面**；那两层里都没有这句', async () => {
    mount({}, threeUnread())
    await waitFor(
      () =>
        expect(alerts()).toEqual([
          DEFAULTS(L('agent.shell.enable'), 'S:终端清单取不到'),
          DEFAULTS(L('agent.websearch.title'), 'W:渠道取不到'),
          DEFAULTS(L('agent.calendar.title'), 'C:日历取不到')
        ]),
      MOUNT_BUDGET
    )
    expect(dangerNow(), '那三项读不到也要被那颗「+」点名').toBe(true)
    // 菜单没开时三句已经在场；开了两层，句子里没有它们（住进浮层＝一关就替这次失败闭嘴）
    await openTools()
    expect((menu() as HTMLElement).textContent).not.toContain('（当前显示的是默认值）')
    expect((toolsMenu() as HTMLElement).textContent).not.toContain('（当前显示的是默认值）')
  })

  it('只读那一档：上下文三行不给（没有可发出去的一句话），但那颗「+」与三行设置照常在、且没有输入框', async () => {
    mount({}, { readOnly: true })
    expect(screen.queryByTitle(L('agent.composerTitle')), '那一档根本不渲染输入框').toBeNull()
    await openPlus()
    expect(screen.queryByTestId('agent-composer-plus-file')).toBeNull()
    expect(screen.queryByText(L('snippet.button'))).toBeNull()
    expect(screen.queryByText(L('mention.knowledge'))).toBeNull()
    // 设置那三行不是"上下文来源"，只读档也要能改（子会话详情里看一眼这台机器开了什么，是 §235 的口径）
    expect(screen.getByTestId('agent-composer-plus-workspace')).toBeTruthy()
    expect(toolsRow()).toBeTruthy()
  })
})
