// V4-Iter-322：技能市场在线 tab——发请求的是那两颗键，不是每一个字符
//
// 现场（逐行回读，行号是本批改前）：
//  · `SkillMarket.tsx:96-106` 那个挂载／切 tab 的 effect 里写着 `if (tab === 'online') fetchRemote(registryUrl)`，
//    而它的依赖数组**含 `registryUrl`**；同一屏的 URL 输入框（`:376-383`）是受控的，
//    `onChange={(e) => setRegistryUrl(e.target.value)}` ⇒ **每敲一个字符就发一条真实网络请求**
//    （默认索引是 `https://raw.githubusercontent.com/...`，主进程 `handlers/skills.ts:52` 既不缓存也不合并）。
//    重头发本来就有两颗显式入口：URL 框的 Enter（`:381`）与「刷新」按钮（`:339-346`）⇒ 逐字符自动拉不是设计。
//  · 另一半是同族的"迟到响应缺归属"：`fetchRemote`（`:79-94`）没有代次，并发时先发起的那条常常后回 ⇒
//    旧那份把新 URL 的清单覆盖掉，而 `setRemoteLoading(false)` 由先回的那条翻掉——屏上写着"已就绪"、
//    内容是另一个索引的（§319／§320／§321 同族：关联号得有人对账）。
//
// 修法＝effect 不再依赖 `registryUrl`（进 online tab 仍拉一次）＋ `remoteSeqRef` 代次：
// 只有最后发起那次的响应允许写屏（清单、错误句、loading 三处都算）。
//
// 用例形状：① 是"该发几条"的计数判据（1 条 → 打字 0 条 → Enter 1 条 → 刷新 1 条），
// ②③ 用两条并发把"迟到的那条"演出来，④ 是正向对照（最新那条失败时错误句照上说，
// 挡住"守卫写成恒不写下屏"这种过闸门改法）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, act, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SkillMarket } from '../src/renderer/src/modules/skills/SkillMarket'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const BUDGET = { timeout: 8000, interval: 50 }

interface Deferred { url: string; resolve: (v: unknown) => void }
let inflight: Deferred[] = []
let calls = 0

const urlBox = (): HTMLInputElement =>
  Array.from(document.querySelectorAll('input')).find((i) => i.value.startsWith('https://')) as HTMLInputElement

/** 主进程那发是异步的：这里把每条请求挂住，由用例决定谁先回、谁后回（真机上先后顺序正是不确定的） */
const answer = async (url: string, payload: unknown): Promise<void> => {
  const idx = inflight.map((d) => d.url).lastIndexOf(url)
  if (idx < 0) throw new Error(`PROBE：没有在飞的请求 ${url}`)
  const [d] = inflight.splice(idx, 1)
  await act(async () => { d!.resolve(payload) })
}

const okWith = (name: string): unknown => ({
  ok: true,
  skills: [{ id: 'r1', name, url: 'https://example.invalid/skill.md' }]
})

function mountMarket(): void {
  inflight = []
  calls = 0
  stubPocketai({
    listSkills: () => [],
    syncSkills: () => ({ count: 0, errors: [] }),
    fetchSkillIndex: (url: string) =>
      new Promise((resolve) => {
        calls += 1
        inflight.push({ url, resolve })
      })
  })
  mountWithProviders(<SkillMarket onClose={() => {}} onChanged={async () => []} />)
}

const openOnlineTab = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(L('skill.market.tabOnline')) }))
  await waitFor(() => expect(calls).toBe(1), BUDGET)
}

beforeEach(() => { cleanup() })
afterEach(() => { cleanup() })

describe('§322 在线 tab：发请求的是那两颗键，不是每一个字符', () => {
  it('进 tab 拉一次；改 URL 的过程中一条都不发；Enter 与「刷新」各发一条', async () => {
    mountMarket()
    await openOnlineTab()
    const box = urlBox()
    const base = box.value

    fireEvent.change(box, { target: { value: `${base}/a` } })
    fireEvent.change(box, { target: { value: `${base}/ab` } })
    fireEvent.change(box, { target: { value: `${base}/abc` } })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(calls, '逐字符 setRegistryUrl 不该各发一条真实网络请求').toBe(1)

    const url2 = `${base}/abc`
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls).toBe(2), BUDGET)
    await answer(url2, okWith('PROBE-BY-ENTER'))
    await waitFor(() => expect(bodyText()).toContain('PROBE-BY-ENTER'), BUDGET)

    fireEvent.click(screen.getByText(L('skill.market.refresh')))
    await waitFor(() => expect(calls).toBe(3), BUDGET)
    await answer(url2, okWith('PROBE-BY-REFRESH'))
    await waitFor(() => expect(bodyText()).toContain('PROBE-BY-REFRESH'), BUDGET)
    expect(bodyText()).not.toContain('PROBE-BY-ENTER')
  })

  it('② 两条并发：先发起的那条后回，不许把新清单覆盖成旧的', async () => {
    mountMarket()
    await openOnlineTab()
    await answer('https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json', okWith('PROBE-FIRST'))

    const box = urlBox()
    const url2 = `${box.value}?v=2`
    fireEvent.change(box, { target: { value: url2 } })
    fireEvent.keyDown(box, { key: 'Enter' }) // #2 先发、故意晚回
    await waitFor(() => expect(inflight.length).toBe(1), BUDGET)
    const url3 = `${url2}?v=3`
    fireEvent.change(box, { target: { value: url3 } })
    fireEvent.keyDown(box, { key: 'Enter' }) // #3 后发、先回
    await waitFor(() => expect(inflight.length).toBe(2), BUDGET)

    await answer(url3, okWith('PROBE-NEWEST'))
    await waitFor(() => expect(bodyText()).toContain('PROBE-NEWEST'), BUDGET)
    await answer(url2, okWith('PROBE-STALE-WINS?'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(bodyText(), '迟到的那条不该把最新清单盖掉').toContain('PROBE-NEWEST')
    expect(bodyText()).not.toContain('PROBE-STALE-WINS?')
  })

  it('③ 迟到的那条带的是错误句 ⇒ 错误也不许上屏（写屏的三处都归最新那条管）', async () => {
    mountMarket()
    await openOnlineTab()
    await answer('https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json', okWith('PROBE-FIRST'))

    const box = urlBox()
    const url2 = `${box.value}?a`
    fireEvent.change(box, { target: { value: url2 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(inflight.length).toBe(1), BUDGET)
    const url3 = `${box.value}?b`
    fireEvent.change(box, { target: { value: url3 } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(inflight.length).toBe(2), BUDGET)

    await answer(url3, okWith('PROBE-NEWEST-2'))
    await waitFor(() => expect(bodyText()).toContain('PROBE-NEWEST-2'), BUDGET)
    await answer(url2, { ok: false, error: 'STALE-INDEX-FAIL', skills: [] })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(bodyText(), '迟到的失败也不许写成屏上那句').not.toContain('STALE-INDEX-FAIL')
    expect(bodyText()).toContain('PROBE-NEWEST-2')
  })

  it('⑤ 最新那条还在飞时，迟到那条不许把"还在加载"翻掉（loading 也归代次管）', async () => {
    mountMarket()
    await openOnlineTab()
    await answer('https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json', okWith('PROBE-FIRST'))
    await waitFor(() => expect(screen.getByText(L('skill.market.refresh'))).toBeTruthy(), BUDGET)

    const box = urlBox()
    const url2 = `${box.value}?late`
    fireEvent.change(box, { target: { value: url2 } })
    fireEvent.keyDown(box, { key: 'Enter' }) // #2 先发、会晚回
    await waitFor(() => expect(inflight.length).toBe(1), BUDGET)
    const url3 = `${url2}?newest`
    fireEvent.change(box, { target: { value: url3 } })
    fireEvent.keyDown(box, { key: 'Enter' }) // #3 是最新那条，仍挂着
    await waitFor(() => expect(inflight.length).toBe(2), BUDGET)
    expect(screen.queryByText(L('skill.market.refresh')), '发出去之后就该显示加载中').toBeNull()

    await answer(url2, okWith('PROBE-STALE-LOADING'))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(screen.queryByText(L('skill.market.refresh')), '迟到的那条不许把 loading 翻掉').toBeNull()
    expect(bodyText()).not.toContain('PROBE-STALE-LOADING')
  })

  it('④ 正向对照：只有最新那条在飞时，它的失败照上说（判据不是"恒不写屏"）', async () => {
    mountMarket()
    await openOnlineTab()
    await answer('https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json', {
      ok: false, error: 'PROBE-FAIL', skills: []
    })
    await waitFor(() => expect(bodyText()).toContain('PROBE-FAIL'), BUDGET)
  })
})
