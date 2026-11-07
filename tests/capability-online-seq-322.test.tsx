// @vitest-environment jsdom
// V4-Iter-322：在线技能索引只按显式触发联网，且迟到的响应不许写屏。
//
// 迁移说明（§429）：原用例挂在 SkillMarket 的「在线 tab + registry URL 框」上——那颗 URL 框随
// 孤儿文件一起删除了，能力中心改成"关键词非空才拉一次 / 点联网加载、刷新"两条显式入口，
// 并且 URL 框的 Enter 现在走 importSkillFromUrl（导入一条技能），不再重拉索引。
// 于是原 5 条按新入口重写成 4 条（②③合并为一条并发用例、⑤ loading 并入同一条），**契约一条没丢**：
//  ① 进面板不发；关键词一发不逐字符压发；URL 框打字不发、Enter 走导入；「刷新」各发一条；
//  ② 迟到的旧清单不许覆盖最新；③ 迟到的旧错误不许上屏；⑤ 迟到的响应不许把 loading 翻回来；
//  ④ 正向：最新那一发失败照常上屏。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { CapabilityCenter } from '../src/renderer/src/modules/skills/CapabilityCenter'
import { zh } from '../src/renderer/src/i18n/zh'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

type Impl = (...a: any[]) => unknown
const onlineSkill = (id: string, name: string): unknown => ({
  id,
  name,
  icon: '⚡',
  description: '在线一条',
  url: `https://probe/${id}`
})

function mount(over: Record<string, Impl> = {}) {
  stubPocketai({
    listSkills: () => [],
    listAssistants: () => [],
    listMcpServers: () => [],
    getMcpRuntimes: () => [],
    getToolPolicy: () => ({ tools: [] }),
    listProviders: () => [],
    onMcpStatus: () => () => {},
    onMcpLog: () => () => {},
    saveSkill: (a: Record<string, unknown>) => a,
    ...over
  })
  return mountWithProviders(<CapabilityCenter onClose={() => {}} onChanged={async () => []} />)
}

const fetchCalls = (): number => pocketaiCalls().filter((c) => c.fn === 'fetchSkillIndex').length

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('322 在线索引：显式触发＋代次守卫', () => {
  it('打开面板不联网；开始搜索只发一发，请求在飞时继续打字不许逐字符压发', async () => {
    let release: ((v: unknown) => void) | null = null
    mount({
      fetchSkillIndex: () =>
        new Promise((res) => {
          release = res
        })
    })
    await screen.findByTestId('capability-search', {}, MOUNT_BUDGET)
    expect(fetchCalls(), '打开面板不联网').toBe(0)

    const box = screen.getByTestId('capability-search')
    fireEvent.change(box, { target: { value: 'a' } })
    await waitFor(() => expect(fetchCalls()).toBe(1), MOUNT_BUDGET)
    // 第一发还没回：后面每一个字符都不许再发
    fireEvent.change(box, { target: { value: 'ab' } })
    fireEvent.change(box, { target: { value: 'abc' } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchCalls(), '在飞的请求没回之前不许逐字符压发').toBe(1)

    await act(async () => {
      ;(release as unknown as (v: unknown) => void)({ ok: true, skills: [onlineSkill('on-1', 'PROBE-abc')] })
    })
    // 正向对照：最新那条确实写了屏（在线段切到"刷新"这一支）
    await waitFor(() => expect(bodyText()).toContain(L('cap.online.refresh')), MOUNT_BUDGET)
  })

  it('URL 导入框不再拉索引：打字不发请求，Enter 走 importSkillFromUrl（只导入一条）', async () => {
    const imports: string[] = []
    mount({
      fetchSkillIndex: () => ({ ok: true, skills: [onlineSkill('on-1', 'PROBE-在线')] }),
      importSkillFromUrl: (url: string) => {
        imports.push(url)
        return { ok: true, skill: { id: 'imp-1', name: 'PROBE-导入', enabled: true } }
      }
    })
    fireEvent.click(await screen.findByTestId('capability-online-load', {}, MOUNT_BUDGET))
    await waitFor(() => expect(fetchCalls()).toBe(1), MOUNT_BUDGET)
    await screen.findByText(L('cap.online.refresh'), {}, MOUNT_BUDGET)

    const urlBox = screen.getByPlaceholderText(L('skill.market.urlImportPh'))
    fireEvent.change(urlBox, { target: { value: 'https://probe/x' } })
    fireEvent.change(urlBox, { target: { value: 'https://probe/xy' } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchCalls(), 'URL 框的每一次击键都不许拉索引').toBe(1)

    fireEvent.keyDown(urlBox, { key: 'Enter' })
    await waitFor(() => expect(imports.length).toBe(1), MOUNT_BUDGET)
    expect(fetchCalls(), 'Enter 走的是导入，不是重拉索引').toBe(1)

    // 刷新键仍是一条显式入口：点一次发一条
    fireEvent.click(screen.getByText(L('cap.online.refresh')))
    await waitFor(() => expect(fetchCalls()).toBe(2), MOUNT_BUDGET)
  })

  it('两发在飞：最新那条后回也不许被迟到的旧清单/旧错误覆盖', async () => {
    const pending: Array<(v: unknown) => void> = []
    mount({
      fetchSkillIndex: () =>
        new Promise((res) => {
          pending.push(res)
        })
    })
    const load = await screen.findByTestId('capability-online-load', {}, MOUNT_BUDGET)
    fireEvent.click(load)
    fireEvent.click(load)
    // 门同时等两件：两发都发出去了、且屏上确实显示"正在加载"（门不许只等桩、断言却读屏）
    await waitFor(() => {
      expect(pending.length).toBe(2)
      expect(bodyText()).toContain(L('cap.online.loading'))
    }, MOUNT_BUDGET)

    // 最新那条回来就收，迟到那条不许把它翻回去
    await act(async () => {
      pending[1]!({ ok: true, skills: [onlineSkill('new', 'ONLINE-NEW')] })
    })
    await waitFor(() => expect(bodyText()).toContain('ONLINE-NEW'), MOUNT_BUDGET)
    expect(bodyText(), '最新那条回来了，loading 要收').not.toContain(L('cap.online.loading'))

    // 迟到那一发带着旧清单＋旧错误：两边都不许写屏（loading 也不许被它翻回"正在加载"）
    await act(async () => {
      pending[0]!({ ok: false, error: 'STALE-ERROR' })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(bodyText(), '迟到那份旧清单不许覆盖最新').toContain('ONLINE-NEW')
    expect(bodyText()).not.toContain('STALE-ERROR')
    expect(bodyText(), '迟到那条不许把 loading 翻回来').not.toContain(L('cap.online.loading'))
  })

  it('正向对照：最新那一发失败要上屏，且 loading 收回去', async () => {
    mount({ fetchSkillIndex: () => ({ ok: false, error: 'PROBE-FETCH-FAIL' }) })
    fireEvent.click(await screen.findByTestId('capability-online-load', {}, MOUNT_BUDGET))
    await waitFor(() => expect(bodyText()).toContain('PROBE-FETCH-FAIL'), MOUNT_BUDGET)
    expect(bodyText()).not.toContain(L('cap.online.loading'))
  })
})
