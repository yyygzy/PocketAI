// V4-Iter-265：闸门第六面开批——命令类那一族「按了停止、指令没送到主进程」，界面却已经改成"已停"的样子。
//
// 这一族不在前五面的口径里：前五面量的都是**读**（拿到失败对象当数据用／判了不接管／判了也只 return）。
// 这里是**命令**：`abortChat`／`abortAgent` 走 `safeHandle`（src/main/ipc/safe-handle.ts:179-182），
// 主进程的失败是**已 resolve 的 `{ok:false,error}`**，所以原先那两句
// `window.pocketai.abortX(id)`（裸发）与 `.catch(reportIpcError(...))`（只有 console）都接不住它——
// 而紧接着一句 `setRunningNow(false)`／`setStreaming(false)` 已经把界面改成"这轮停了"。
// 探针实测（临时用例跑完即删）：Agent 页那条路是
//   选 provider→选 model→发送→「停止」键在场→点它→`abortAgent` 回 `{ok:false}` ⇒
//   旧形状屏上 `alerts()` 为空（零提示），而那一轮仍在跑、token 仍在烧。
//
// 收口口径（沿 §264 那条已经定过的）：**不阻断照旧**——按钮照常立刻回到发送态，不把"说实话"做成"禁掉输入"；
// 只补一句「送没送到」。这句**独立成一行**，不挂在别的判据之下（§264 抓到的那条：一发挂掉不许替另一发闭嘴）。
// 并给一次「再送」：停止键在界面复位后就不在了，句子必须有自家出口 ⇒ 记着 requestId 才谈得上重发。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ConversationRecord, MessageRecord, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
/** 那句是 `common.stopNotSent` 填上原因后的整句（带重试键时用"屏上有这句"判，不比文本框等值——§264 同一条） */
const SENTENCE = (msg: string): string => L('common.stopNotSent').replace('{msg}', msg)

/** 挂载级等待预算（满载时这条链要四跳以上，判据仍是等状态；见台账 §261／§264） */
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

// ───────── ① Agent 页：那颗「停止」按下去之后的那张脸 ─────────

const glm: ProviderRecord = {
  id: 'glm', type: 'openai-compatible', name: 'GLM', baseUrl: 'https://api.example.invalid/v1',
  apiKeys: [], models: ['glm-4.6'], enabled: true, createdAt: 1
} as unknown as ProviderRecord
const PARENT: ConversationRecord = { id: 'c1', assistantId: 'a1', title: 'PROBE-会话', createdAt: 1, updatedAt: 1 } as unknown as ConversationRecord

/** 本用例只关心"跑到哪一步、停止送没送到"，其余桩照 §264 那份 harness 的形状抄 */
const agentStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [glm],
  listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
  getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
  setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
  listConversations: (_a: string, _agent: boolean, archivedOnly?: boolean) => (archivedOnly ? [] : [PARENT]),
  listMessages: (id: string) => [{ id: `m-${id}`, conversationId: id, role: 'user', content: '跑一趟', createdAt: 1 }] as MessageRecord[],
  getLatestRunStats: () => null,
  getSessionStats: () => ({ runCount: 1, totalDurationMs: 1200, totalTokens: 900 }),
  getLatestRunTraces: () => [],
  getAgentTextProtocol: () => [],
  getModelContextWindows: () => ({}),
  getFallbackTargets: () => ({}),
  setFallbackTarget: () => ({ targets: {} }),
  getConversation: (id: string) => (id === 'c1' ? PARENT : null),
  listChildConversations: () => [],
  getAgentWorkspaceDir: () => '',
  getShellConfig: () => ({}),
  getWebSearchConfig: () => ({}),
  getCalendarConfig: () => ({}),
  fetchModels: () => ({ ok: true }),
  sendMessage: () => ({ ok: true }),
  abortAgent: () => ({ ok: true }),
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

/**
 * 走到"这一轮正在跑"那一帧（探针实测的三步）：等挂载到货 → 选 provider → 选 model → 输入 → 发送。
 * 少任何一步，那颗「停止」都不在场——不假装它已经在屏上。
 */
async function mountAndRun(impls: Record<string, (...a: any[]) => unknown>): Promise<void> {
  stubPocketai(agentStubs(impls))
  mountWithProviders(<AgentPanel />)
  // 挂载见证用会话栏里那条会话的标题（§261 组②同一条）——本次运行统计那块在桩里给的是 null，不作为见证
  await waitFor(() => expect(screen.getByText('PROBE-会话')).toBeTruthy(), MOUNT_BUDGET)
  const pick = async (optValue: string): Promise<void> => {
    const sel = Array.from(document.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === optValue))
    expect(sel, `屏上该有一个能选 ${optValue} 的下拉`).toBeTruthy()
    fireEvent.change(sel!, { target: { value: optValue } })
    await waitFor(() => expect(sel!.value).toBe(optValue), MOUNT_BUDGET)
  }
  await pick('glm')
  await pick('glm-4.6')
  const ta = document.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: '跑一趟' } })
  fireEvent.click(screen.getByText(L('common.send')))
  await waitFor(() => expect(screen.getByText(L('common.stop'))).toBeTruthy(), MOUNT_BUDGET)
  fireEvent.click(screen.getByText(L('common.stop')))
}

describe('① Agent 页：按了停止而指令没送到，不许安静地当成"已停"', () => {
  it('回 {ok:false} ⇒ 那句上屏，且界面照常回到可发送态（不阻断这条没动）', async () => {
    await mountAndRun({ abortAgent: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    expect(alerts()).toHaveLength(1)
    // 「没送到」要说，但不许顺手把界面变成"停不下来所以别按"——发送键照常可用
    const send = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === L('common.send'))
    expect(send, '界面仍回到未运行态（这条行为没改）').toBeTruthy()
    expect((send as HTMLButtonElement).disabled).toBe(true) // 输入框已清空 ⇒ 空文本时禁用，而不是被这句禁掉
  })

  it('点「再送一次」这回落成功 ⇒ 那句必须退场（陈旧谎报不能留着，§256）', async () => {
    let fail = true
    const abortAgent = (): unknown => (fail ? { ok: false, error: 'ABORT:通道断了' } : { ok: true })
    await mountAndRun({ abortAgent })
    await waitFor(() => expect(alerts()).toHaveLength(1))
    fail = false
    fireEvent.click(screen.getByTestId('stop-retry'))
    await waitFor(() => expect(alerts()).toEqual([]))
  })

  it('reject 面（通道真抛，不是 `{ok:false}`）⇒ 同一句、用抛出的原文', async () => {
    await mountAndRun({ abortAgent: () => Promise.reject(new Error('停止通道炸了')) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('停止通道炸了')))
  })

  it('反向对照：这发真的送到了 ⇒ 屏上一句"没送到"都不许有（不把停成功说成失败）', async () => {
    await mountAndRun({ abortAgent: () => ({ ok: true }) })
    await waitFor(() => expect(screen.getByText('PROBE-会话')).toBeTruthy(), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain('没送到')
  })

  it('重发用的是**同一发**的 requestId（不是替用户新开一轮）', async () => {
    const ids: string[] = []
    let fail = true
    await mountAndRun({
      abortAgent: (id: string) => {
        ids.push(id)
        return fail ? { ok: false, error: 'ABORT:通道断了' } : { ok: true }
      }
    })
    await waitFor(() => expect(alerts()).toHaveLength(1))
    fail = false
    fireEvent.click(screen.getByTestId('stop-retry'))
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(ids, '两发都是那一轮的 id（重发不产生新一轮）').toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })
})

// ───────── ② 浮窗：同一条形状的另一块屏 ─────────

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

const popupStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [{ ...PROVIDER, models: ['m1'] }],
  listAssistants: () => [{ id: 'a1', name: 'PROBE-ASSIST', isBuiltin: true }],
  getPopupPayload: () => null,
  onPopupPayload: () => () => {},
  fetchModels: () => ['m1'],
  getUiPrefs: () => ({ ok: true, data: {} }),
  setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
  createConversation: () => ({ id: 'cv1' }),
  sendMessage: () => ({ ok: true }),
  abortChat: () => ({ ok: true }),
  hidePopup: () => ({ ok: true }),
  onChatChunk: () => () => {},
  onChatDone: () => () => {},
  onChatError: () => () => {},
  ...over
})

/** 浮窗走到"正在回答"那一帧：选 provider→选助手→输入→发送（探针实测的路） */
async function popupAndRun(impls: Record<string, (...a: any[]) => unknown>): Promise<void> {
  stubPocketai(popupStubs(impls))
  mountWithProviders(<PopupApp />)
  await waitFor(() => expect(bodyText()).toContain('PROBE-PROVIDER'), MOUNT_BUDGET)
  const ta = document.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: '记一句' } })
  await waitFor(() => expect(ta.value).toBe('记一句'), MOUNT_BUDGET)
  fireEvent.click(screen.getByText(L('common.send')))
  await waitFor(() => expect(screen.getByText(L('common.stop'))).toBeTruthy(), MOUNT_BUDGET)
  fireEvent.click(screen.getByText(L('common.stop')))
}

describe('② 浮窗：那句挂在自己的行上，不跟三发读挤在同一块', () => {
  it('回 {ok:false} ⇒ 那句上屏、带一颗重试', async () => {
    await popupAndRun({ abortChat: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    expect(screen.getByTestId('popup-stop-retry')).toBeTruthy()
  })

  it('点重试这回落成功 ⇒ 那句退场', async () => {
    let fail = true
    await popupAndRun({ abortChat: () => (fail ? { ok: false, error: 'ABORT:通道断了' } : { ok: true }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    fail = false
    fireEvent.click(screen.getByTestId('popup-stop-retry'))
    await waitFor(() => expect(bodyText()).not.toContain('没送到'))
  })

  it('反向对照：三发读全好、停止也送到 ⇒ 屏上零 alert（这句不许自己冒出来）', async () => {
    await popupAndRun({ abortChat: () => ({ ok: true }) })
    await waitFor(() => expect(bodyText()).toContain('记一句'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })
})
