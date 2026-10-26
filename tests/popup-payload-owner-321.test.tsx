// V4-Iter-321：浮窗那份载荷"是谁的、算几次"（真挂载 PopupApp）
//
// 现场（逐行读过才写）：
//  · `main/popup.ts:276` 每次唤起把载荷存进 `lastPayload`；投递有两条路——渲染端挂载时自己 pull
//    （`PopupApp.tsx:129`）＋主进程在 `once('did-finish-load')` 里补 push（`main/popup.ts:246-248`），
//    冷启动那一次开窗**两条都会走**，同一个 `applyPayload` 被喂两遍。
//  · 载荷类型里带着 `ts`（`shared/types.ts:1222-1228`，主进程 `:276` 每份都填），但改前 `applyPayload`
//    只是把它写进 `pendingActionRef`（`:92`），**全仓没有任何地方读它**（`:420` 取的是 `pending.action`）
//    ⇒ 重复投递没有幂等判据：第一次自动执行已经把待发清掉，第二份"其实早就处理过"的载荷又把它武装回来，
//    流式一结束（`streaming` 翻 false 是这个 effect 的依赖项）就**再发一条用户没要求的请求**。
//  · 另一半：`:90` 只在"带 action"时写 ref，**从不写 null** ⇒ 一份没跑成的旧动作（`:417`/`:418` 早退时
//    pending 是留着等条件的）会在 provider／模型凑齐那一刻跑在**新**选中文本上——内容错配的自动发送。
//
// 修法：按内容认同一份载荷（ts＋mode＋text＋action 四样全等才算重复，重复的那份整个不当数）；
// 每一份新载荷都重新定义待发动作，不带 action 就是把待发的清掉。主进程不动——`ts` 本来就在载荷里，
// 缺的只是有人读它。
//
// 用例形状：反面配正向对照（②③ 证"判据不是恒不收下／不是恒不武装"），④ 钉住"同一毫秒的两份不同内容
// 不算重复"——只用 ts 当判据会在那一刻把用户第二次唤起悄悄吃掉。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, waitFor, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import type { PopupPayload } from '../src/shared/types'

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const ASSISTANT = { id: 'a1', name: '通用问答', isBuiltin: true }

/** StrictMode 会「订阅→卸载→再订阅」⇒ 记全部回调，投的时候全投（死掉那次自己不再跑） */
let pushers: Array<(p: PopupPayload) => void> = []
let doneCbs: Array<(e: unknown) => void> = []
let sends: Array<{ requestId: string; content: string }> = []
let pullValue: PopupPayload | null = null

const sel = (ts: number, text: string, action?: PopupPayload['action']): PopupPayload =>
  ({ mode: 'selection', text, action, ts })

/** 挂载前的桩：pull 那一读的结果显式传进来（避免"先设全局、再被桩清掉"这种顺序坑） */
function stubPopup(pull: PopupPayload | null, over: Record<string, (...a: any[]) => unknown> = {}): void {
  pushers = []
  doneCbs = []
  sends = []
  pullValue = pull
  stubPocketai({
    listProviders: () => [PROVIDER],
    listAssistants: () => [ASSISTANT],
    getPopupPayload: () => pullValue,
    onPopupPayload: (cb: (p: PopupPayload) => void) => {
      pushers.push(cb)
      return () => { pushers = pushers.filter((x) => x !== cb) }
    },
    onChatChunk: () => () => {},
    onChatDone: (cb: (e: unknown) => void) => {
      doneCbs.push(cb)
      return () => { doneCbs = doneCbs.filter((x) => x !== cb) }
    },
    onChatError: () => () => {},
    createConversation: () => ({ id: 'cv1' }),
    sendMessage: (p: { requestId: string; content: string }) => {
      sends.push({ requestId: p.requestId, content: p.content })
      return Promise.resolve({ ok: true })
    },
    abortChat: () => ({ ok: true }),
    hidePopup: () => ({ ok: true }),
    fetchModels: () => ['m1'],
    ...over
  })
}

/** 让主进程那条 push 路再投一次同一份载荷（真机里这一步是 did-finish-load 的补推） */
const deliver = async (p: PopupPayload): Promise<void> => {
  await act(async () => { pushers.forEach((cb) => cb(p)) })
}

/** 流式收尾：把 done 事件按 requestId 投回去，`streaming` 才翻 false（那是自动执行 effect 的依赖项） */
const finishStreaming = async (requestId: string): Promise<void> => {
  await act(async () => { doneCbs.forEach((cb) => cb({ requestId, targetIndex: 0, fullContent: 'PROBE-REPLY' })) })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  // 浮窗会把选中的 provider／model 存进 localStorage（LS_PROVIDER／LS_MODEL）并在挂载时读回来。
  // 不清的话：前一条用例留下的 'p1'／'m1' 会让 ③ 的"条件还没齐"提前成立，旧动作在第二次投递之前就自己跑掉了
  window.localStorage.clear()
  // jsdom 不实现 Element.scrollTo（真实 Chromium 有），浮窗挂载时会自动滚到底 ⇒ 补个空实现（§204 同款）
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('§321 浮窗载荷的归属与幂等', () => {
  it('① 同一份载荷被 pull＋push 各投一次 ⇒ 自动执行只跑一条（改前：流式一结束就补发第二条）', async () => {
    const payload = sel(1000, 'PROBE-SELECTED', 'translate')
    stubPopup(payload)
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(sends.length).toBe(1))
    await deliver(payload) // 改前：这一份把待发动作重新武装回来了
    await finishStreaming(sends[0]!.requestId)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sends.map((s) => s.content), '重复投递不该多出第二条请求').toHaveLength(1)
  })

  it('② 正向对照：真正的新载荷（新内容＋新 ts）该跑就跑，判据不是"恒不收下"', async () => {
    stubPopup(sel(2000, 'PROBE-FIRST', 'translate'))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(sends.length).toBe(1))
    await finishStreaming(sends[0]!.requestId)
    await deliver(sel(2001, 'PROBE-SECOND', 'summary'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sends.length, '新的一份要执行').toBe(2)
    expect(sends[1]!.content).toContain('PROBE-SECOND')
  })

  it('③ 不带 action 的新载荷把待发动作清掉 ⇒ 旧动作不许跑在新文本上', async () => {
    const gate: { release: ((v: unknown) => void) | null } = { release: null }
    stubPopup(null, {
      // 让 provider／模型这一读**晚到**：先投两份载荷，再放行条件——旧动作正是在这种"等着凑条件"的窗口里赖着的
      listProviders: () => new Promise((resolve) => { gate.release = resolve }),
      listAssistants: () => [ASSISTANT]
    })
    mountWithProviders(<PopupApp />)
    await deliver(sel(3000, 'PROBE-OLD-TEXT', 'polish')) // 带旧动作，但条件没齐 ⇒ 不跑、pending 留着
    await deliver(sel(3001, 'PROBE-NEW-TEXT')) // 快捷键取词那一类：不带动作
    await act(async () => { gate.release?.([PROVIDER]) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sends.map((s) => s.content), '旧动作既不该跑在旧文本上，更不该跑在新文本上').toEqual([])
  })

  it('④ 同一毫秒的两份不同内容不算重复（只用 ts 当判据会把第二次唤起吃掉）', async () => {
    stubPopup(sel(4000, 'PROBE-A', 'translate'))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(sends.length).toBe(1))
    await finishStreaming(sends[0]!.requestId)
    await deliver(sel(4000, 'PROBE-B', 'summary')) // ts 相同、内容不同
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(sends.length, '内容不同就是新的一份，要执行').toBe(2)
    expect(sends[1]!.content).toContain('PROBE-B')
  })
})
