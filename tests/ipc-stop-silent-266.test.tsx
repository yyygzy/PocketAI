// V4-Iter-266：第六面第二簇——静默桶里那三颗**真按钮**（对话页／翻译页／绘图页的「停止」）。
//
// §265 收的是「按了停止、界面自己说已停」那一档；这三处不同：running 不动、等那一发自己收尾，
// 所以屏上留下的不是谎，而是**点了没反应、也没人说话**（§263 定的 fail-closed）。
// 但「没停下来」对用户是要紧事（流还在跑、token 还在烧），所以还是得说一句。
//
// 三条与 §265 不同的形状决定（都是这三屏自己的形状决定的，不是套模板）：
//  · **不再另配一颗重试键**：这三处的「停止」在句子在场时本来就还挂着（running 为真），再按一次就是重发；
//    多一颗键是多余的机关。为此 §265 那句提示语里的"可再送一次停止"被拿掉——句子只说后果，出路各屏自己给。
//  · **那句只在 running 在场**：那一发落定后"可能还在继续"就成了新的谎 ⇒ 翻译／绘图挂在 running 分支里，
//    对话页由 hook 的 finalize 自己收回（用例⑤专门钉这条）。
//  · 对话页这处的**渲染方**是 ChatModule（全仓不挂载）⇒ 那一句只有源码级判据；产它的 hook 有行为用例（①～⑤）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { useStreamSession } from '../src/renderer/src/modules/chat/useStreamSession'
import { ImageModule } from '../src/renderer/src/modules/image/ImageModule'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const SENTENCE = (msg: string): string => L('common.stopNotSent').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

// ───────── ① 对话页：hook 那一发（ChatModule 的渲染方只有源码级判据） ─────────

let emitDone: ((e: { requestId: string; targetIndex: number }) => void) | null = null

const streamStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  onChatChunk: () => () => {},
  // 抓住 DONE 回调：用例要能"让这一发真的落定"，才好判那句会不会过期
  onChatDone: (h: (e: { requestId: string; targetIndex: number }) => void) => {
    emitDone = h
    return () => {}
  },
  onChatError: () => () => {},
  abortChat: () => ({ ok: true }),
  ...over
})

const mountHook = (impls: Record<string, (...a: any[]) => unknown> = {}) => {
  stubPocketai(streamStubs(impls))
  emitDone = null
  return renderHook(() => useStreamSession({
    loadMessages: () => {},
    reloadConversations: () => {},
    getCurrentConvId: () => 'c1'
  }), { wrapper: HookProviders })
}

/** 起一轮流式（单列）并点「停止」 */
function startAndStop(r: ReturnType<typeof mountHook>): string {
  let id = ''
  act(() => { id = r.result.current.beginStream('c1', [{ providerId: 'p1', model: 'm1' }]) ?? '' })
  expect(id, 'beginStream 该返回这一发的 requestId').not.toBe('')
  act(() => r.result.current.abort())
  return id
}

describe('① 对话页那颗停止（hook 侧）：没送到要说，且落定后要过期', () => {
  it('回 {ok:false} ⇒ stopUnread 有原因，且不打断界面（isStreaming 仍是真）', async () => {
    const r = mountHook({ abortChat: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    startAndStop(r)
    await waitFor(() => expect(r.result.current.stopUnread).toEqual({ error: 'ABORT:通道断了' }))
    expect(r.result.current.isStreaming(), '这句不许顺手把流式状态改成"已停"').toBe(true)
  })

  it('再按一次这回落成功 ⇒ 那句收回（陈旧谎报不留着）', async () => {
    let fail = true
    const r = mountHook({ abortChat: () => (fail ? { ok: false, error: 'ABORT:通道断了' } : { ok: true }) })
    startAndStop(r)
    await waitFor(() => expect(r.result.current.stopUnread).not.toBeNull())
    fail = false
    act(() => r.result.current.abort())
    await waitFor(() => expect(r.result.current.stopUnread).toBeNull())
  })

  it('reject 面（通道真抛）⇒ 同一个形状、用抛出的原文', async () => {
    const r = mountHook({ abortChat: () => Promise.reject(new Error('停止通道炸了')) })
    startAndStop(r)
    await waitFor(() => expect(r.result.current.stopUnread).toEqual({ error: '停止通道炸了' }))
  })

  it('反向对照：这发真送到了 ⇒ stopUnread 一直是 null（不把停成功说成没送到）', async () => {
    const r = mountHook({ abortChat: () => ({ ok: true }) })
    startAndStop(r)
    await waitFor(() => expect(r.result.current.isStreaming()).toBe(true))
    expect(r.result.current.stopUnread).toBeNull()
  })

  it('这一轮随后自己落定 ⇒ 那句必须作废（"还在继续"到点了就是新的谎）', async () => {
    const r = mountHook({ abortChat: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    const id = startAndStop(r)
    await waitFor(() => expect(r.result.current.stopUnread).not.toBeNull())
    await act(async () => { emitDone!({ requestId: id, targetIndex: 0 }) })
    await waitFor(() => expect(r.result.current.stopUnread).toBeNull())
    expect(r.result.current.isStreaming(), '落定之后不再流式（收尾路径本来就这样）').toBe(false)
  })
})

// ───────── ②③ 绘图页／翻译页：真挂载，句子挂在 running 分支里 ─────────

const hang = (): Promise<unknown> => new Promise(() => {})

const imageStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listImages: () => [],
  getImageFile: () => ({ ok: true }),
  generateImage: hang,
  abortImage: () => ({ ok: true }),
  ...over
})

/** 绘图页那颗是「⏹ 停止」两个节点拼起来的 ⇒ 用"文本包含"找，不用等值 */
const imageStopBtn = (): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(L('image.stop')))

/** 走到"这一发正在生成"那一帧：填提示词→点生成（generateImage 永不落定，running 就一直留着） */
async function imageAndRun(impls: Record<string, (...a: any[]) => unknown>): Promise<void> {
  stubPocketai(imageStubs(impls))
  mountWithProviders(<ImageModule />)
  await waitFor(() => expect(bodyText()).toContain('PROBE-PROVIDER'), MOUNT_BUDGET)
  // 模型只在"换服务商"那条 onChange 里落到 models[0]（初始 effect 只填 providerId）⇒ 先选一次服务商
  const sel = Array.from(document.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'p1'))
  expect(sel, '服务商下拉在场').toBeTruthy()
  fireEvent.change(sel!, { target: { value: 'p1' } })
  await waitFor(() => expect(sel!.value).toBe('p1'), MOUNT_BUDGET)
  const ta = document.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: '画一张' } })
  const go = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(L('image.generate')))
  expect(go, '生成键在场').toBeTruthy()
  fireEvent.click(go!)
  await waitFor(() => expect(imageStopBtn()).toBeTruthy(), MOUNT_BUDGET)
  fireEvent.click(imageStopBtn()!)
}

describe('② 绘图页那颗停止：失败说一句，且这句只在生成中还挂着', () => {
  it('回 {ok:false} ⇒ 那句上屏、停止键仍在（再按一次就是重发，所以不另配重试键）', async () => {
    await imageAndRun({ abortImage: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    expect(alerts()).toHaveLength(1)
    expect(imageStopBtn(), '出路就是这颗键，没有多余的机关').toBeTruthy()
    expect(screen.queryByTestId('stop-retry'), '本批这三处不配重试键').toBeNull()
  })

  it('再按一次这回落成功 ⇒ 那句退场', async () => {
    let fail = true
    await imageAndRun({ abortImage: () => (fail ? { ok: false, error: 'ABORT:通道断了' } : { ok: true }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    fail = false
    fireEvent.click(imageStopBtn()!)
    await waitFor(() => expect(alerts()).toEqual([]))
  })

  it('reject 面 ⇒ 同一句用抛出的原文（旧写法是 `.catch(reportIpcError(...))`＝对 safeHandle 的失败是死代码）', async () => {
    await imageAndRun({ abortImage: () => Promise.reject(new Error('停止通道炸了')) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('停止通道炸了')))
  })

  it('反向对照：停止真送到 ⇒ 零 alert，生成状态照旧由那一发收尾', async () => {
    await imageAndRun({ abortImage: () => ({ ok: true }) })
    await waitFor(() => expect(imageStopBtn()).toBeTruthy())
    expect(alerts()).toEqual([])
  })

  it('那句只在生成中在场：这一发随后自己落定 ⇒ 它必须跟着消失（挂在 running 分支里就是为了这个）', async () => {
    let settle: (() => void) | null = null
    await imageAndRun({
      abortImage: () => ({ ok: false, error: 'ABORT:通道断了' }),
      // 生成那一发改成"可外部落定"的 promise：落定后 running 复位，句子该随之消失
      generateImage: () => new Promise((res) => { settle = () => res({ ok: false, error: 'aborted' }) })
    })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    await act(async () => { settle!() })
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(bodyText(), '生成状态已落定，那句"还在继续"不许留着').not.toContain('ABORT:通道断了')
  })
})

const translateStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listTranslations: () => [],
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  translate: hang,
  abortTranslate: () => ({ ok: true }),
  ...over
})

async function translateAndRun(impls: Record<string, (...a: any[]) => unknown>): Promise<void> {
  stubPocketai(translateStubs(impls))
  mountWithProviders(<TranslateModule />)
  await waitFor(() => expect(bodyText()).toContain('PROBE-PROVIDER'), MOUNT_BUDGET)
  const tas = Array.from(document.querySelectorAll('textarea'))
  fireEvent.change(tas[0]!, { target: { value: 'hello' } })
  const go = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(L('translate.run')))
  expect(go, '翻译键在场').toBeTruthy()
  fireEvent.click(go!)
  await waitFor(() => expect(screen.getByText(L('translate.stop'))).toBeTruthy(), MOUNT_BUDGET)
  fireEvent.click(screen.getByText(L('translate.stop')))
}

describe('③ 翻译页那颗停止：同一条形状', () => {
  it('回 {ok:false} ⇒ 那句上屏', async () => {
    await translateAndRun({ abortTranslate: () => ({ ok: false, error: 'ABORT:通道断了' }) })
    await waitFor(() => expect(bodyText()).toContain(SENTENCE('ABORT:通道断了')))
    expect(alerts()).toHaveLength(1)
  })

  it('反向对照：送到 ⇒ 零 alert（不把停成功说成失败）', async () => {
    await translateAndRun({ abortTranslate: () => ({ ok: true }) })
    await waitFor(() => expect(bodyText()).toContain(L('translate.stop')))
    expect(alerts()).toEqual([])
  })
})
