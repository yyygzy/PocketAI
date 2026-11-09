// V4-Iter-265：闸门第六面开批——命令类那一族「按了停止、指令没送到主进程」，界面却已经改成"已停"的样子。
//
// 这一族不在前五面的口径里：前五面量的都是**读**（拿到失败对象当数据用／判了不接管／判了也只 return）。
// 这里是**命令**：`abortChat`／`abortAgent` 走 `safeHandle`（src/main/ipc/safe-handle.ts:179-182），
// 主进程的失败是**已 resolve 的 `{ok:false,error}`**，所以原先那两句
// `window.pocketai.abortX(id)`（裸发）与 `.catch(reportIpcError(...))`（只有 console）都接不住它——
// 而紧接着一句 `setRunningNow(false)`／`setStreaming(false)` 已经把界面改成"这轮停了"。
// 探针实测（临时用例跑完即删）：浮窗那条路是
//   选 provider→选助手→输入→发送→「停止」键在场→点它→`abortChat` 回 `{ok:false}` ⇒
//   旧形状屏上 `alerts()` 为空（零提示），而那一轮仍在跑、token 仍在烧。
//
// 收口口径（沿 §264 那条已经定过的）：**不阻断照旧**——按钮照常立刻回到发送态，不把"说实话"做成"禁掉输入"；
// 只补一句「送没送到」。这句**独立成一行**，不挂在别的判据之下（§264 抓到的那条：一发挂掉不许替另一发闭嘴）。
// 并给一次「再送」：停止键在界面复位后就不在了，句子必须有自家出口 ⇒ 记着 requestId 才谈得上重发。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ProviderRecord } from '../src/shared/types'

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
