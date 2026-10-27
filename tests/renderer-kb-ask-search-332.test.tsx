// V4-Iter-332（A6／A7）：知识库问答那两屏的**历史搜索**——防抖只拦新发送、不拦旧响应。
//
// 两处同族（`KbAskPanel.tsx:104` `refreshSessions`／`KbAskRoam.tsx:28` `refresh`）：
//  · 搜索框每改一次词，200ms 防抖后发一发；改前响应侧没有归属判据 ⇒
//    前一个词那一发若是**后到**，会把当前那个词的结果整张换掉；
//  · 空态那句按**当前**关键词取（`kb.askSearchEmpty`／`kb.roamSearchEmpty`）⇒
//    屏上挂着上一批条目，同一时刻又说「无匹配」；
//  · 前一个词那一发若是**失败**，还会替当前那一次把「读不到」挂上屏（当前那发明明还没答复）。
// A7 是同一颗按钮的另一半：`历史（N）` 的 N 取的是 `sessionList.length`，
// 而关闭面板此前只清关键词**不重拉** ⇒ 搜过一个只命中 1 条的词再关掉，按钮长期报「历史（1）」，
// 库里其实 3 条。两条一起修：有关键词时不报数、关闭时清词并重拉。
//
// 时序不靠 sleep：每发的 resolve 握在用例手里（按队列存）；等防抖靠 `waitFor` 到"这一发真的挂在飞"。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { KbAskRoam } from '../src/renderer/src/modules/knowledge/KbAskRoam'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbAskRoamItem, KbAskSessionMeta, KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

/** 那两发都带 200ms 防抖，等到"这一发确实挂在飞"预算要放宽 */
const DEBOUNCE = { timeout: 5000, interval: 20 }
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

/** 在飞请求：`键 → 该键所有未兑现的 resolve`（队列不是单槽位——§309 的教训） */
let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** `.then → setState` 还要再排一次微任务＋一次宏任务（§309 那条） */
const flush = async (fn: () => void): Promise<void> => {
  await act(async () => {
    fn()
    await settle()
  })
}

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const KB = { id: 'kb1', name: 'PROBE-KB', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

const meta = (id: string): KbAskSessionMeta =>
  ({
    id, kbId: 'kb1', title: `会话 ${id}`, messageCount: 1,
    providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1
  }) as unknown as KbAskSessionMeta

const roamItem = (id: string): KbAskRoamItem =>
  ({
    id, kbId: 'kb1', kbName: 'PROBE-KB', title: `漫游 ${id}`,
    messageCount: 2, updatedAt: 1, model: ''
  }) as unknown as KbAskRoamItem

const HIST_WHAT = L('kb.askHistory')
const ROAM_WHAT = L('kb.roamTitle')
const historyBtn = (): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${HIST_WHAT}`) })
const searchBox = (): HTMLElement => screen.getByPlaceholderText(L('kb.askSearchPlaceholder'))

/** 本库历史：挂载读一发、点开那一格再读一发，都同步返回整库那 3 条 */
let listCalls = 0
function panelStubs(): Record<string, any> {
  q = {}
  listCalls = 0
  return {
    listProviders: () => [PROVIDER],
    listKbAskSessions: () => {
      listCalls += 1
      return [meta('s1'), meta('s2'), meta('s3')]
    },
    searchKbAskSessions: (_kbId: string, kw: string) => pend(`ask:${kw}`),
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {}
  }
}

function roamStubs(): Record<string, any> {
  q = {}
  return {
    listAllKbAskSessions: () => [roamItem('r0')],
    searchAllKbAskSessions: (kw: string) => pend(`roam:${kw}`)
  }
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

// ---------- A6① 问答屏：连敲两个词 ----------
describe('§332 A6① 问答屏历史搜索：前一个词那一发的迟到结果不许换掉当前结果', () => {
  beforeEach(() => {
    stubPocketai(panelStubs())
    mountWithProviders(<KbAskPanel kb={KB} />)
  })

  it('敲「甲」再敲「甲乙」⇒「甲」迟到了也不许换掉「甲乙」的清单', async () => {
    fireEvent.click(historyBtn())
    await waitFor(() => expect(screen.getByPlaceholderText(L('kb.askSearchPlaceholder'))).toBeTruthy())

    fireEvent.change(searchBox(), { target: { value: '甲' } })
    await waitFor(() => expect(q['ask:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(searchBox(), { target: { value: '甲乙' } })
    await waitFor(() => expect(q['ask:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    // 当前那个词先答复
    await flush(() => answer('ask:甲乙', [meta('S-乙乙')]))
    expect(screen.getByText('会话 S-乙乙')).toBeTruthy()

    // 现在才放行挂着的那一发：修前它会把整张列表换成「甲」的结果
    await flush(() => answer('ask:甲', [meta('S-甲甲')]))
    expect(screen.queryByText('会话 S-甲甲'), '迟到那一发不许换掉当前关键词的清单').toBeNull()
    expect(screen.getByText('会话 S-乙乙'), '当前关键词的结果也不许被顺手清掉').toBeTruthy()
  })

  it('迟到那一发是失败 ⇒ 不许替当前那一次挂「读不到」；当前那发自己失败要挂上（正向对照）', async () => {
    fireEvent.click(historyBtn())
    await waitFor(() => expect(searchBox()).toBeTruthy())

    fireEvent.change(searchBox(), { target: { value: '甲' } })
    await waitFor(() => expect(q['ask:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(searchBox(), { target: { value: '甲乙' } })
    await waitFor(() => expect(q['ask:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    await flush(() => answer('ask:甲', { ok: false, error: 'BOOM-迟到那发' }))
    expect(alerts(), '当前那一发还没答复，「读不到」不许由迟到那发代挂').toEqual([])

    await flush(() => answer('ask:甲乙', [meta('S-乙乙')]))
    expect(screen.getByText('会话 S-乙乙'), '迟到那发的失败也不许吞掉当前结果').toBeTruthy()

    // 正向对照：代次判据不是"把响应全丢掉"——当前那发自己失败时那句必须上屏
    fireEvent.change(searchBox(), { target: { value: '甲乙丙' } })
    await waitFor(() => expect(q['ask:甲乙丙']?.length).toBeTruthy(), DEBOUNCE)
    await flush(() => answer('ask:甲乙丙', { ok: false, error: 'BOOM-当前那发' }))
    await waitFor(() => expect(alerts()).toContain(NAMED(HIST_WHAT, 'BOOM-当前那发')), MOUNT_BUDGET)
  })

  it('reject 面的迟到那一发也不许替当前那一次挂「读不到」（`.catch` 里那道是独立一支）', async () => {
    fireEvent.click(historyBtn())
    await waitFor(() => expect(searchBox()).toBeTruthy())
    fireEvent.change(searchBox(), { target: { value: '甲' } })
    await waitFor(() => expect(q['ask:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(searchBox(), { target: { value: '甲乙' } })
    await waitFor(() => expect(q['ask:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    await flush(() => answer('ask:甲', Promise.reject(new Error('BOOM-迟到断了'))))
    expect(alerts(), '当前那一发还在飞，那句不许由迟到那发的 reject 代挂').toEqual([])

    await flush(() => answer('ask:甲乙', [meta('S-乙乙')]))
    expect(screen.getByText('会话 S-乙乙'), '迟到那发断了也不许吞掉当前结果').toBeTruthy()
  })

  // ---------- A7 那颗按钮的「（N）」 ----------
  it('搜过一个只命中 1 条的词再关闭面板 ⇒ 按钮报整库那 3 条，而关闭那一趟确实重拉', async () => {
    fireEvent.click(historyBtn())
    await waitFor(() => expect(searchBox()).toBeTruthy())
    const before = listCalls

    fireEvent.change(searchBox(), { target: { value: '甲' } })
    await waitFor(() => expect(q['ask:甲']?.length).toBeTruthy(), DEBOUNCE)
    await flush(() => answer('ask:甲', [meta('S-只这一条')]))
    expect(historyBtn().textContent, '有关键词时不报数（那是一份筛选结果）').toBe(HIST_WHAT)

    fireEvent.click(historyBtn()) // 关闭：清词 + 重拉
    expect(listCalls, '关闭面板必须重拉，否则那颗按钮的数拿的是上一份筛选结果').toBeGreaterThan(before)
    await waitFor(() => expect(historyBtn().textContent).toBe(`${HIST_WHAT}（3）`), MOUNT_BUDGET)

    fireEvent.click(historyBtn()) // 再点开：列表本身也得回到整库那一份
    await waitFor(() => expect(screen.getByText('会话 s1')).toBeTruthy(), MOUNT_BUDGET)
    expect(screen.queryByText('会话 S-只这一条'), '那份筛选结果不许留在面板里').toBeNull()
  })
})

// ---------- A6② 漫游屏：连敲两个词 ----------
describe('§332 A6② 跨库漫游搜索：同一族，迟到清单与迟到失败都不许顶掉当前那一份', () => {
  beforeEach(() => {
    stubPocketai(roamStubs())
    mountWithProviders(<KbAskRoam onOpen={() => {}} />)
  })

  it('敲「甲」再敲「甲乙」⇒「甲」迟到了不许换掉「甲乙」的清单', async () => {
    await waitFor(() => expect(screen.getByText('漫游 r0')).toBeTruthy(), MOUNT_BUDGET)
    const box = screen.getByPlaceholderText(L('kb.roamSearchPlaceholder'))

    fireEvent.change(box, { target: { value: '甲' } })
    await waitFor(() => expect(q['roam:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(box, { target: { value: '甲乙' } })
    await waitFor(() => expect(q['roam:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    await flush(() => answer('roam:甲乙', [roamItem('r-乙乙')]))
    expect(screen.getByText('漫游 r-乙乙')).toBeTruthy()

    await flush(() => answer('roam:甲', [roamItem('r-甲甲')]))
    expect(screen.queryByText('漫游 r-甲甲'), '迟到那一发不许换掉当前关键词的清单').toBeNull()
    expect(screen.getByText('漫游 r-乙乙'), '当前关键词的结果也不许被顺手清掉').toBeTruthy()
  })

  it('迟到那一发是失败 ⇒ 不许替当前那一次挂「读不到」；当前那发自己失败要挂上（正向对照）', async () => {
    await waitFor(() => expect(screen.getByText('漫游 r0')).toBeTruthy(), MOUNT_BUDGET)
    const box = screen.getByPlaceholderText(L('kb.roamSearchPlaceholder'))

    fireEvent.change(box, { target: { value: '甲' } })
    await waitFor(() => expect(q['roam:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(box, { target: { value: '甲乙' } })
    await waitFor(() => expect(q['roam:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    await flush(() => answer('roam:甲', { ok: false, error: 'BOOM-迟到那发' }))
    expect(alerts(), '当前那一发还没答复，「读不到」不许由迟到那发代挂').toEqual([])

    await flush(() => answer('roam:甲乙', [roamItem('r-乙乙')]))
    expect(screen.getByText('漫游 r-乙乙'), '迟到那发的失败也不许吞掉当前结果').toBeTruthy()

    fireEvent.change(box, { target: { value: '甲乙丙' } })
    await waitFor(() => expect(q['roam:甲乙丙']?.length).toBeTruthy(), DEBOUNCE)
    await flush(() => answer('roam:甲乙丙', { ok: false, error: 'BOOM-当前那发' }))
    await waitFor(() => expect(alerts()).toContain(NAMED(ROAM_WHAT, 'BOOM-当前那发')), MOUNT_BUDGET)
  })

  it('reject 面的迟到那一发也不许替当前那一次挂「读不到」（`.catch` 里那道是独立一支）', async () => {
    await waitFor(() => expect(screen.getByText('漫游 r0')).toBeTruthy(), MOUNT_BUDGET)
    const box = screen.getByPlaceholderText(L('kb.roamSearchPlaceholder'))
    fireEvent.change(box, { target: { value: '甲' } })
    await waitFor(() => expect(q['roam:甲']?.length).toBeTruthy(), DEBOUNCE)
    fireEvent.change(box, { target: { value: '甲乙' } })
    await waitFor(() => expect(q['roam:甲乙']?.length).toBeTruthy(), DEBOUNCE)

    await flush(() => answer('roam:甲', Promise.reject(new Error('BOOM-迟到断了'))))
    expect(alerts(), '当前那一发还在飞，那句不许由迟到那发的 reject 代挂').toEqual([])

    await flush(() => answer('roam:甲乙', [roamItem('r-乙乙')]))
    expect(screen.getByText('漫游 r-乙乙'), '迟到那发断了也不许吞掉当前结果').toBeTruthy()
  })
})
