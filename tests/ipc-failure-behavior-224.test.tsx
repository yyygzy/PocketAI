// @vitest-environment jsdom
// V4-Iter-224：§223 记的那条"仍未收口"——渲染层把真抛错咽掉的空 `.catch`，21 处（不是我一开始数的 16 处）。
//
// 这一族与 §217～§223 管的**不是同一个面**：那几批判的是 `{ok:false}` 这个 resolve 值，
// 而 `.catch` 天生接不到它。所以这一面的高价值缺陷不是"谎报成功"，而是
// **成功回调自己抛错／通道没注册／参数不可序列化这三类真故障，一点痕迹都不留**——
// 用户按了「停止」而流还在跑、离开终端模块而 shell 成了孤儿、切了语言而菜单没变，界面上全是一片正常。
// 收口一律沿用各文件已有的那张脸：后台读类只 `reportIpcError` 留痕（不改观感），
// 只有"乐观改完状态的写"（保留策略那颗下拉）才回滚＋说话，因为它已经骗了用户一次。
//
// 用例的形状因此和 218／220 不同：**断言的是 console.warn 里那句留痕在不在**，
// 每处都配反向对照（成功路径不许冒 warn），把"为了过闸门而每次调用都记一条"这种写法挡住。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { TerminalModule } from '../src/renderer/src/modules/terminal/TerminalModule'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase } from '../src/shared/types'
import React from 'react'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
/** role=status 的盒子：toast 与内联 Notice 都算（§218 的读数口径，不滤空串） */
const panels = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const kb = { id: 'kb1', name: '测试库' } as unknown as KnowledgeBase

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())
/** 只挑出本批关心的那几条留痕，别的（React/订阅噪音）不算 */
const traces = (): string[] => warns.filter((w) => w.startsWith('[ipc] '))

describe('① 知识库问答的「自动清理」下拉：真抛错不许把乐观值留在屏上', () => {
  const stubs = (saveImpl: () => unknown) => ({
    listProviders: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    listKbAskSessions: () => [],
    searchKbAskSessions: () => [],
    setKbAskRetention: saveImpl,
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {}
  })
  /** 展开历史面板 → 展开保留策略 → 把「每库最多保留」改成 50 */
  const pickCount = async (): Promise<HTMLSelectElement> => {
    await settle()
    fireEvent.click(screen.getByText(new RegExp(`^${L('kb.askHistory')}`)))
    await settle()
    fireEvent.click(screen.getByText(L('kb.askRetention')))
    await settle()
    const label = screen.getByText(L('kb.askRetentionCount'))
    const sel = label.nextElementSibling as HTMLSelectElement
    fireEvent.change(sel, { target: { value: '50' } })
    await settle()
    return sel
  }

  it('reject ⇒ 下拉回到改之前的值，且 toast 逐字给出原因（§221 只管到了 resolve 面这一半）', async () => {
    stubPocketai(stubs(() => Promise.reject(new Error('库被占用'))))
    mountWithProviders(<KbAskPanel kb={kb} />)
    const sel = await pickCount()
    await waitFor(() => expect(panels().join('|')).toContain('库被占用'))
    expect(sel.value).toBe('0')
  })

  it('反向对照：resolve 的成功 ⇒ 新值留住 ＋ 那句「已保存」，一条 [ipc] 留痕都不许有', async () => {
    stubPocketai(stubs(() => ({ ok: true })))
    mountWithProviders(<KbAskPanel kb={kb} />)
    const sel = await pickCount()
    await waitFor(() => expect(panels().join('|')).toContain(L('kb.askRetentionSaved')))
    expect(sel.value).toBe('50')
    expect(traces()).toEqual([])
  })
})

describe('② 离开终端模块时 killTerminal 真抛错 ⇒ 从此在 console 里留痕', () => {
  it('卸载路径上 reject ⇒ console.warn 有 `[ipc] terminal.killTerminal 失败: …`（孤儿 shell 是 §197／§202 那一族，看不见才是问题）', async () => {
    stubPocketai({
      startTerminal: () => ({ ok: true }),
      onTerminalOutput: () => () => {},
      killTerminal: () => Promise.reject(new Error('pty 已退出')),
      terminalInput: () => ({ ok: true })
    })
    const { unmount } = mountWithProviders(<TerminalModule />)
    await waitFor(() => expect(traces()).toEqual([]))
    unmount()
    await settle()
    expect(traces()).toEqual(['[ipc] terminal.killTerminal 失败: pty 已退出'])
  })

  it('反向对照：卸载时 kill 成功 ⇒ 零留痕（挡住"每次卸载都记一条"这种过闸门写法）', async () => {
    stubPocketai({
      startTerminal: () => ({ ok: true }),
      onTerminalOutput: () => () => {},
      killTerminal: () => ({ ok: true }),
      terminalInput: () => ({ ok: true })
    })
    const { unmount } = mountWithProviders(<TerminalModule />)
    await settle()
    unmount()
    await settle()
    expect(traces()).toEqual([])
  })
})

describe('③ i18n 那句"通道还没注册"是设计内的 reject：只吞这一句，其余照样留痕', () => {
  const mount = (impl: () => unknown): void => {
    stubPocketai({ setAppLanguage: impl })
    mountWithProviders(React.createElement('div', null, 'x'))
  }

  it('reject 里带 "No handler registered" ⇒ 不记（解锁窗／浮窗挂载早于主进程注册是正常路径）', async () => {
    mount(() => Promise.reject(new Error("Error invoking remote method 'MENU_SET_LANGUAGE': Error: No handler registered for 'MENU_SET_LANGUAGE'")))
    await settle()
    expect(traces()).toEqual([])
  })

  it('其它 reject ⇒ 留痕：菜单语言没同步是真故障，不能和那一句一起被吞', async () => {
    mount(() => Promise.reject(new Error('pty 挂了')))
    await settle()
    expect(traces()).toEqual(['[ipc] i18n.setAppLanguage 失败: pty 挂了'])
  })
})
