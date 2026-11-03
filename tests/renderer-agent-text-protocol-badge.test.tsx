// 「文本协议」开关的界面契约：三态文案、悬停说明、点下去传什么，以及零调用提示的互斥规则
// @vitest-environment jsdom
//
// 为什么要这条：B55 第①条写的是"未启用时徽标是灰的、点一下变高亮"，而灰/高亮这种词
// 在代码里其实是三串不同的文案 + 三个不同的 title。只靠真机肉眼看过一次，没人能回答
// "改坏文案会不会有人发现"。这里把**能由 DOM 断言的那一半**钉住；颜色与排版仍属真机。
// 另一条更关键：Iter-113 自己撞出来的死路——开关若只藏在零调用提示里，生效后提示不再出现
// 就关不掉了。所以「入口常驻可达」与「两条为什么互斥」是同一份契约的两半，一起测。
//
// §399②a 搬家：这颗开关原来挂在顶栏 `AgentModelBar`，现在住在输入框那颗「+」的菜单里。
// 「常驻可达」这条没破——判据从"徽标一直在栏上"换成"那颗「+」一直在输入行上，且不受任何状态条件支配"，
// 所以这里既点它、也钉它在 running／未选模型／读不到三种情况下入口还在不在。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentComposer } from '../src/renderer/src/modules/agent/components/AgentComposer'
import { AgentModelBar } from '../src/renderer/src/modules/agent/components/AgentModelBar'
import { zeroCallNoticeFlags } from '../src/renderer/src/modules/agent/agent-shared'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MENU_BUDGET = { timeout: 8000, interval: 50 }

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

const att = {
  attachments: [],
  dragOver: false,
  addFiles: () => {},
  addAttachment: () => {},
  removeAt: () => {},
  clear: () => {},
  openPicker: () => {},
  fileInputProps: {},
  dropZoneProps: {},
  pasteProps: {}
}

/** 挂输入区并把那颗「+」点开；`over`＝那颗开关三项的覆盖（forced／unread／available） */
function mountMenu(opts: {
  forced?: boolean
  unread?: string | null
  available?: boolean
  running?: boolean
  onToggle?: (on: boolean) => void
} = {}) {
  const onToggle = opts.onToggle ?? vi.fn()
  stubPocketai({ listKnowledgeBases: () => [], listPromptSnippets: () => [] })
  mountWithProviders(
    React.createElement(
      AgentComposer,
      {
        running: opts.running ?? false,
        canSend: true,
        att: att as never,
        onSend: () => {},
        onAbort: () => {},
        queue: [],
        queueFull: false,
        onQueue: () => {},
        onInterject: () => {},
        onDropQueued: () => {},
        onSendQueuedNow: () => {},
        textProtocolAvailable: opts.available ?? true,
        textProtocolForced: opts.forced ?? false,
        textProtocolUnread: opts.unread ?? null,
        onToggleTextProtocol: onToggle,
        onRetryTextProtocol: () => {},
        workspaceDir: '',
        workspaceUnread: null,
        onPickWorkspace: () => {},
        onRetryWorkspace: () => {}
      } as never
    )
  )
  fireEvent.click(screen.getByTestId('agent-composer-plus'))
  return onToggle
}

beforeEach(() => {
  stubPocketai({})
})

describe('那颗「+」里的「文本协议」那一行（§399②a 之前的落点是模型栏）', () => {
  it('未启用：文案是「文本协议」，悬停说明讲的是"什么时候该用它"', async () => {
    mountMenu()
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
    const row = screen.getByTestId('agent-composer-plus-text-protocol')
    expect(row.textContent).toBe(L('agent.textProtocol'))
    expect(row.getAttribute('title')).toBe(L('agent.textProtocolHint'))
    expect(row.getAttribute('role')).toBe('menuitemcheckbox')
    expect(row.getAttribute('aria-checked')).toBe('false')
    // 反向对照：未启用时不能出现"已启用"那串，否则用户以为开关已经生效
    expect(screen.queryByText(L('agent.textProtocolOn'))).toBeNull()
  })

  it('已启用：文案换成「文本协议已启用」，悬停说明换成"点击关闭"', async () => {
    mountMenu({ forced: true })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
    const row = screen.getByTestId('agent-composer-plus-text-protocol')
    expect(row.textContent).toBe(L('agent.textProtocolOn'))
    expect(row.getAttribute('title')).toBe(L('agent.textProtocolOnHint'))
    expect(row.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(L('agent.textProtocol'))).toBeNull()
  })

  it('点一下传的是「取反后的目标状态」：关着点 → true，开着点 → false', async () => {
    const off = mountMenu()
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
    fireEvent.click(screen.getByTestId('agent-composer-plus-text-protocol'))
    expect(off).toHaveBeenCalledTimes(1)
    expect(off).toHaveBeenCalledWith(true)
  })

  it('开着那一档点一下传 false（关闭入口就在同一行上，不必先找别的机关）', async () => {
    const on = mountMenu({ forced: true })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
    fireEvent.click(screen.getByTestId('agent-composer-plus-text-protocol'))
    expect(on).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith(false)
  })

  it('入口常驻可达（Iter-113 那条死路的现代判据）：菜单收掉之后那颗「+」还在，且它不受任何状态条件支配', async () => {
    mountMenu({ forced: true })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-menu')).not.toBeNull(), MENU_BUDGET)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-menu')).toBeNull(), MENU_BUDGET)
    expect(screen.getByTestId('agent-composer-plus'), '那颗入口不该随菜单收合一起消失').toBeTruthy()
    // 关闭入口只有这一处＝协议生效后即使零调用提示再也不出现，也仍然关得掉
    expect(screen.queryAllByTestId('agent-composer-plus-text-protocol').length, '菜单开着才有那一行，不重复开第二处入口').toBe(0)
    fireEvent.click(screen.getByTestId('agent-composer-plus'))
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
  })

  it('运行中那一行照旧可点（这一发是"下一轮生效"的设置，不是这一轮的附件，不该被排队规则拦下）', async () => {
    const on = mountMenu({ running: true, forced: true })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-text-protocol')).not.toBeNull(), MENU_BUDGET)
    const row = screen.getByTestId('agent-composer-plus-text-protocol') as HTMLButtonElement
    expect(row.disabled, '把关闭入口在运行中禁用＝又造一次 Iter-113 那条死路').toBe(false)
    fireEvent.click(row)
    expect(on).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith(false)
  })

  it('还没选到模型时不出现那一行（作用域是 provider+model，没有目标就不该给一个能点的开关）', async () => {
    mountMenu({ available: false })
    await waitFor(() => expect(screen.queryByTestId('agent-composer-plus-menu')).not.toBeNull(), MENU_BUDGET)
    expect(screen.queryByTestId('agent-composer-plus-text-protocol')).toBeNull()
    expect(screen.queryByText(L('agent.textProtocol'))).toBeNull()
    expect(screen.queryByText(L('agent.textProtocolOn'))).toBeNull()
  })

  it('顶栏那份第二脸搬走了：模型栏里既没有这颗开关、也没有那颗 📁', () => {
    stubPocketai({})
    mountWithProviders(
      <AgentModelBar
        providers={[glm]}
        providerId="glm"
        model="glm-4.6"
        onProviderChange={() => {}}
        onModelChange={() => {}}
        selectedProvider={glm}
        fetchingModels={false}
        onFetchModels={() => {}}
      />
    )
    expect(screen.queryByText(L('agent.textProtocol'))).toBeNull()
    expect(screen.queryByText(L('agent.textProtocolOn'))).toBeNull()
    expect(screen.queryByText(L('agent.workspaceNone'))).toBeNull()
  })
})

describe('窄窗口不许把两个下拉压成 0 宽（模型栏剩下的那半契约）', () => {
  it('这一栏必须能换行，两个下拉必须有最小宽度', () => {
    stubPocketai({})
    mountWithProviders(
      <AgentModelBar
        providers={[glm]}
        providerId="glm"
        model="glm-4.6"
        onProviderChange={() => {}}
        onModelChange={() => {}}
        selectedProvider={glm}
        fetchingModels={false}
        onFetchModels={() => {}}
      />
    )
    // jsdom 没有排版引擎，量不出像素，所以这里只能钉住**约束本身还在**：
    // 窗口一窄，下拉一旦被压到 0 宽，选中值就完全看不见（2026-10-13 真机截图正是这个现象）。
    const bar = screen.getByText(L('agent.modelConfig')).parentElement!
    expect(bar.className).toContain('flex-wrap')
    for (const sel of Array.from(bar.querySelectorAll('select'))) {
      expect(sel.className).toMatch(/min-w-\[\d+px\]/)
    }
  })
})

describe('零调用提示里两条「为什么」互斥', () => {
  const base = { mcpHeldBack: 0, providerId: 'glm', model: 'glm-4.6', textProtocolForced: false }

  it('有 MCP 工具被挡：只说被挡，不再劝改用文本协议', () => {
    const r = zeroCallNoticeFlags({ ...base, mcpHeldBack: 3 })
    expect(r).toEqual({ showHeldBack: true, showSuggest: false })
  })

  it('没有工具被挡、且开关还没开：才给"改用文本协议"的建议', () => {
    expect(zeroCallNoticeFlags(base)).toEqual({ showHeldBack: false, showSuggest: true })
  })

  it('开关已经打开时不重复建议（否则点不到关闭入口，正是 Iter-113 撞过的那条死路）', () => {
    expect(zeroCallNoticeFlags({ ...base, textProtocolForced: true }).showSuggest).toBe(false)
  })

  it('没选服务商/模型时不给建议（那时"零调用"的原因就是根本没有目标可发）', () => {
    expect(zeroCallNoticeFlags({ ...base, providerId: '' }).showSuggest).toBe(false)
    expect(zeroCallNoticeFlags({ ...base, model: '' }).showSuggest).toBe(false)
  })
})
