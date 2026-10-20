// @vitest-environment jsdom
// V4-Iter-223：闸门新两档（`value-use`／链根识别）逼出的点，挑三处演成界面事实。
//
// 这三处的共同点是"以前闸门根本看不见"：
//   ① `setItems(await listReminders())` —— 绑定失败 ⇒ bound 为 null ⇒ 旧口径只看"有没有包 try…catch"，
//      于是它一路绿灯，而失败对象进 state 后 `items.length` 为假、`items.map` 当场 TypeError（提醒中心打不开）；
//   ② `(await getEncryptionStatus()).mode` —— 同上，且这条判定决定"要不要弹凭据确认"，静默错过不可审计；
//   ③ `deleteMessage(dbId)` 的失败 —— `.catch(reportIpcError)` 接不到 resolve 的失败 ⇒ 消息"删掉了"而库里还在。
// 反向对照各一条：改"失败要留痕"改到"成功也留痕／成功不生效"同样是回归。
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import { HookProviders, mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { isUnprotectedMode } from '../src/renderer/src/utils/secret-consent'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const ZH = zh as unknown as Record<string, string>
const L = (key: string): string => ZH[key]!
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settleAfter = async (fn: string): Promise<void> => {
  await waitFor(() => expect(calledFns()).toContain(fn))
  await settle()
}

const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* jsdom 没有布局，滚动是空操作 */ }
})

describe('① 提醒中心：改前 `{ok:false}` 直接写进列表 state ⇒ 那句 `items.map` 当场崩', () => {
  const reminder = { id: 'r1', dueAt: Date.now() + 60_000, text: '探针提醒', status: 'pending' }

  it('listReminders 回 {ok:false} ⇒ 不崩、明说「读不到：库被占用」，且「加载中…」不在场', async () => {
    stubPocketai({
      listReminders: () => FAIL,
      onReminderFired: () => () => { /* 订阅卸载函数 */ },
      onReminderChanged: () => () => { /* 同上 */ }
    })
    mountWithProviders(<RemindersModal onClose={() => { /* 用例不关心关闭 */ }} />)
    await settleAfter('listReminders')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
    // 崩了的形状是"整个 modal 空白"：这里以标题仍在为证（改前是 React 抛错后什么都不剩）。
    // 标题带 emoji 前缀（`⏰ 提醒中心`），所以用子串匹配而不是整串相等
    expect(screen.getAllByText(L('reminder.center.title'), { exact: false }).length).toBeGreaterThan(0)
  })

  it('反向对照：读到一条 ⇒ 列表里就是那条，一个 alert 都没有', async () => {
    stubPocketai({
      listReminders: () => [reminder],
      onReminderFired: () => () => { /* 同上 */ },
      onReminderChanged: () => () => { /* 同上 */ }
    })
    mountWithProviders(<RemindersModal onClose={() => { /* 同上 */ }} />)
    await settleAfter('listReminders')
    expect(alerts()).toEqual([])
    expect(screen.getByText('探针提醒')).toBeTruthy()
  })
})

describe('② 凭据确认的前置判定：resolve 的失败以前一句痕都不留（catch 进不去）', () => {
  it('getEncryptionStatus 回 {ok:false} ⇒ 结论仍是"不必打扰"（B3 既有口径），但 console.warn 里要留痕', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 收着，别刷 CI */ })
    stubPocketai({ getEncryptionStatus: () => FAIL })
    await expect(isUnprotectedMode()).resolves.toBe(false)
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('secretConsent.getEncryptionStatus')
    warn.mockRestore()
  })

  it('反向对照：读到 mode=db ⇒ 说"不是明文"，且不打痕（留痕不是"每次都喊一声"）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 同上 */ })
    stubPocketai({ getEncryptionStatus: () => ({ mode: 'db', dbEncrypted: true }) })
    await expect(isUnprotectedMode()).resolves.toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const CONV = { id: 'c1', assistantId: 'a1', title: '会话', modelLabel: null } as unknown as ConversationRecord
const DB_MSG = { id: 'dm1', conversationId: 'c1', role: 'assistant', content: '库里的回答', dbId: 7, createdAt: 1 }

describe('③ Agent 页删一条消息：库里没删掉，界面不能什么都不说', () => {
  const baseStubs = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, unknown> => ({
    getUiPrefs: () => ({ ok: true, data: {} }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    listConversations: () => [CONV],
    listMessages: () => [DB_MSG],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getAgentTextProtocol: () => [],
    // §234：模型栏那颗「上下文窗口」挂载要读这张表（桩给空表=没有一台设过）
    getModelContextWindows: () => ({}),
    setModelContextWindow: () => ({ windows: {} }),
    onAgentStep: () => () => { /* 订阅卸载函数 */ },
    onAgentChunk: () => () => { /* 同上 */ },
    onAgentDone: () => () => { /* 同上 */ },
    onAgentError: () => () => { /* 同上 */ },
    onConversationTitle: () => () => { /* 同上 */ },
    ...over
  })

  const mountChat = async (over: Record<string, (...a: unknown[]) => unknown>): Promise<{ current: ReturnType<typeof useAgentChat> }> => {
    stubPocketai(baseStubs(over) as Record<string, never>)
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    await settle()
    return result
  }

  it('deleteMessage 回 {ok:false} ⇒ toast 逐字给原因（视图已删、库里还在，这件事必须说出来）', async () => {
    const result = await mountChat({ deleteMessage: () => FAIL })
    expect(result.current.messages.length).toBe(1)
    await act(async () => { await result.current.deleteMessage(result.current.messages[0]!.id) })
    expect(toasts()).toEqual(['库被占用'])
    expect(result.current.messages.length).toBe(0)
  })

  it('反向对照：删成功 ⇒ 一条提示都不弹，列表里那条消失', async () => {
    const result = await mountChat({ deleteMessage: () => ({ deleted: true }) })
    await act(async () => { await result.current.deleteMessage(result.current.messages[0]!.id) })
    expect(toasts()).toEqual([])
    expect(result.current.messages.length).toBe(0)
  })

  it('真抛错那一面仍由 .catch 留痕（两条路各半，谁也别顶掉谁）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 收着，别刷 CI */ })
    // 用**拒绝的 Promise**而不是同步 throw：真 IPC 的失败是异步的，同步抛会绕过 .catch（桩不能自己造出一种不存在的路）
    const result = await mountChat({ deleteMessage: () => Promise.reject(new Error('IPC 挂了')) })
    await act(async () => { await result.current.deleteMessage(result.current.messages[0]!.id) })
    expect(toasts()).toEqual([])
    expect(result.current.messages.length).toBe(0)
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('agent.deleteMessage')
    warn.mockRestore()
  })
})
