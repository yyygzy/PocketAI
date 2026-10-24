// V4-Iter-272：第四面静默名单第五簇——知识库问答那两屏三发清单读。
//
// 名单现查 26 条里这一族占三条，分在两屏（逐条原文 data/tmp/silent-272.json）：
//  · `KbAskPanel.tsx:89`——挂载读**本库历史会话**（无关键词 `listKbAskSessions`，有关键词 `searchKbAskSessions`）；
//  · `KbAskPanel.tsx:115`——挂载读**自动清理保留策略**（`getKbAskRetention`）；
//  · `KbAskRoam.tsx:26`——挂载读**跨库问答历史**（`listAllKbAskSessions`／`searchAllKbAskSessions`）。
// 改前三发的失败侧都是 `if (!hasIpcFailed(v)) 写 state`＝什么都不做，于是三张谎脸：
//  · 历史面板摆「暂无历史会话」，而工具行那颗按钮上的 `（{n}）` 跟着报 0＝"你一条都没问过"；
//  · 保留策略停在字面量 `{0,0}`（＝关闭），那两个下拉**照旧可编辑**，用户在这份假基线上改一下就把它存进库
//    ——这一张说的是 §226 那一族「读不到，这里显示的是默认值」，所以用 `ShowingDefaultsNotice`，不用 §222 那一块；
//  · 漫游面板摆「暂无问答历史」。
//
// **重试键只给两颗，历史那一发不造键**：现查 `KbAskPanel.tsx:467` 那颗「历史」按钮的 onClick 里写着
// `if (!showHistory) refreshSessions()`——再点那一格就是重拉（§268 口径）。
// 这条不靠口头理由：用例 ①-3 当场量，失败后再点那一格 ⇒ 通道多打一次、那句不出现、计数回来。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { KbAskRoam } from '../src/renderer/src/modules/knowledge/KbAskRoam'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbAskRoamItem, KbAskSessionMeta, KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const DEFAULTS = (what: string, msg: string): string =>
  L('common.loadFailedDefaults').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const HIST_WHAT = L('kb.askHistory')
const RETENTION_WHAT = L('kb.askRetention')
const ROAM_WHAT = L('kb.roamTitle')
const HIST_FAIL = NAMED(HIST_WHAT, 'HIST:历史通道断了')
const RETENTION_FAIL = DEFAULTS(RETENTION_WHAT, 'RET:策略通道断了')
const ROAM_FAIL = NAMED(ROAM_WHAT, 'ROAM:漫游通道断了')

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const KB = { id: 'kb1', name: 'PROBE-KB', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase
const SESSION = { id: 's1', title: 'PROBE-会话', messageCount: 3, updatedAt: 1, createdAt: 1 } as unknown as KbAskSessionMeta
const ROAM_ITEM = {
  id: 's9', kbId: 'kb1', kbName: 'PROBE-KB', title: 'PROBE-漫游条目',
  messageCount: 2, updatedAt: 1, model: ''
} as unknown as KbAskRoamItem

/** 逐发调用次数：证"点一颗键只重发自己那一发"与"再点那一格就是重拉" */
const calls = { sessions: 0, retention: 0, roam: 0 }

/** 那颗「历史」按钮的可及名会带条数（`历史（2）`）或不带（读不到时），所以按前缀取 */
const historyBtn = (): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${HIST_WHAT}`) })

function panelStubs(over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> {
  calls.sessions = 0
  calls.retention = 0
  return {
    listProviders: () => [PROVIDER],
    getKbAskRetention: () => {
      calls.retention += 1
      return { keepCount: 0, keepDays: 0 }
    },
    listKbAskSessions: () => {
      calls.sessions += 1
      return [SESSION]
    },
    searchKbAskSessions: () => [],
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    ...over
  }
}

function mountPanel(stubs: Record<string, any>): void {
  stubPocketai(stubs)
  mountWithProviders(<KbAskPanel kb={KB} />)
}

function roamStubs(over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> {
  calls.roam = 0
  return {
    listAllKbAskSessions: () => {
      calls.roam += 1
      return [ROAM_ITEM]
    },
    searchAllKbAskSessions: () => [],
    ...over
  }
}

/** 覆盖工厂时必须自己计数——否则"这一发打了几次"就读不出来（§271 同款坑） */
const failingSessions = (msg: string) => (): any => {
  calls.sessions += 1
  return { ok: false, error: msg }
}
const rejectingSessions = () => {
  calls.sessions += 1
  return Promise.reject(new Error('历史通道断了'))
}

function mountRoam(stubs: Record<string, any>): void {
  stubPocketai(stubs)
  mountWithProviders(<KbAskRoam onOpen={() => {}} />)
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('① 本库历史那一发：那句上屏、不报条数，出口是再点那一格（所以不造键）', () => {
  it('挂载失败而面板没开 ⇒ 屏上零字，而那颗按钮不再报 0', async () => {
    mountPanel(panelStubs({ listKbAskSessions: failingSessions('HIST:历史通道断了') }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    expect(alerts(), '面板没展开时那句不占位（失败侧只让数字闭嘴）').toEqual([])
    expect(bodyText(), '把通道故障演成"你一条都没问过"').not.toContain(`${HIST_WHAT}（0）`)
    expect(historyBtn().textContent).toBe(HIST_WHAT)
  })

  it('点开那一格 ⇒ 那句上屏、「暂无历史会话」让位，而这一发没有第二颗机关', async () => {
    mountPanel(panelStubs({ listKbAskSessions: failingSessions('HIST:历史通道断了') }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toContain(HIST_FAIL), MOUNT_BUDGET)
    expect(screen.queryByText(L('kb.askNoSessions'))).toBeNull()
    expect(screen.queryByTestId('kb-ask-sessions-retry'), '这一发的出路是再点那一格，不造键').toBeNull()
  })

  it('再点那一格自己就会重拉：通道多打一次、读到 ⇒ 那句不出现、计数回来（不造键的现证）', async () => {
    let fail = true
    mountPanel(panelStubs({
      listKbAskSessions: () => {
        calls.sessions += 1
        return fail ? { ok: false, error: 'HIST:历史通道断了' } : [SESSION]
      }
    }))
    // 注：上面的工厂也会数一次，这里以"次数增长"为准，不锚绝对值
    await waitFor(() => expect(calls.sessions).toBeGreaterThanOrEqual(1), MOUNT_BUDGET)
    const before = calls.sessions
    fail = false
    fireEvent.click(historyBtn())
    expect(calls.sessions, '点开＝重发这一发').toBeGreaterThan(before)
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(historyBtn().textContent).toBe(`${HIST_WHAT}（1）`)
    expect(bodyText()).toContain('PROBE-会话')
  })

  it('reject 面同一张脸（旧写法只留一条 [ipc] 留痕）', async () => {
    mountPanel(panelStubs({ listKbAskSessions: rejectingSessions }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toContain(NAMED(HIST_WHAT, '历史通道断了')), MOUNT_BUDGET)
  })

  it('反向对照：读到两条 ⇒ 零 alert、按钮带数、条目上屏', async () => {
    mountPanel(panelStubs({ listKbAskSessions: () => [SESSION, { ...SESSION, id: 's2', title: 'PROBE-会话二' }] }))
    await waitFor(() => expect(historyBtn().textContent).toBe(`${HIST_WHAT}（2）`), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(bodyText()).toContain('PROBE-会话二'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(screen.queryByText(L('kb.askNoSessions'))).toBeNull()
  })
})

describe('② 保留策略那一发：「这里显示的是默认值」那句＋它自己的那颗键', () => {
  it('策略读不到 ⇒ 那句用第二形态上屏；那颗键点了有效，而且不去重发历史那一发', async () => {
    let fail = true
    mountPanel(panelStubs({
      getKbAskRetention: () => {
        calls.retention += 1
        return fail ? { ok: false, error: 'RET:策略通道断了' } : { keepCount: 100, keepDays: 0 }
      }
    }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toContain(RETENTION_FAIL), MOUNT_BUDGET)
    const before = { sessions: calls.sessions, retention: calls.retention }
    fail = false
    fireEvent.click(screen.getByTestId('kb-ask-retention-retry'))
    await waitFor(() => expect(calls.retention).toBe(before.retention + 1), MOUNT_BUDGET)
    expect(calls.sessions, '策略那颗键只重发策略这一发').toBe(before.sessions)
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
  })

  it('说实话不等于禁输入：策略读不到时那两个下拉仍可改、那颗「自动清理」仍可点', async () => {
    mountPanel(panelStubs({ getKbAskRetention: () => ({ ok: false, error: 'RET:策略通道断了' }) }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toContain(RETENTION_FAIL), MOUNT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: RETENTION_WHAT }))
    const selects = screen.getAllByRole('combobox').filter((el) => (el as HTMLSelectElement).options.length >= 5)
    expect(selects.length, '那两个数字下拉在场').toBeGreaterThanOrEqual(2)
    for (const s of selects) expect((s as HTMLSelectElement).disabled, '不被那句吃掉').toBe(false)
  })

  // 两个方向各一条：**同一条用例里挂两棵树会让 queryAllByRole 把两个 DOM 都数进来**（第一次跑就是这么红的）
  it('一发挂掉不许替另一发闭嘴（正向）：策略读到而历史挂 ⇒ 只有历史那句', async () => {
    mountPanel(panelStubs({ listKbAskSessions: failingSessions('HIST:历史通道断了') }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toEqual([HIST_FAIL]), MOUNT_BUDGET)
    expect(bodyText(), '读到的一份不许被另一发说成不可信').not.toContain(RETENTION_WHAT + '读不到')
  })

  it('一发挂掉不许替另一发闭嘴（反向）：历史读到而策略挂 ⇒ 只有策略那句，历史照常列', async () => {
    mountPanel(panelStubs({ getKbAskRetention: () => ({ ok: false, error: 'RET:策略通道断了' }) }))
    await waitFor(() => expect(calls.sessions).toBe(1), MOUNT_BUDGET)
    fireEvent.click(historyBtn())
    await waitFor(() => expect(alerts()).toEqual([RETENTION_FAIL]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-会话')
    expect(bodyText(), '策略那句不替历史编一句').not.toContain(HIST_FAIL)
  })

  // §286 B159：那一格此前只在源码注释（`KbAskPanel.tsx:572` 那句「这一发全文件只有挂载一处读、
  // 那颗『自动清理』按钮只展开行、不重读」）里。这里钉的是**那颗按钮切换 showRetention 状态、不重发
  // `getKbAskRetention` 通道**——成功路径挂一次 ⇒ 打开历史面板、点两次「自动清理」（收起再展开），
  // 通道计数仍应停在 1。§272 那批留下的 9 例都没读这个数：那颗 `kb-ask-retention-retry` 键（第 183–188
  // 那条）证的是"点重试键确实会多打一次"，反方向"点开行不会多打"此前没测过。
  it('§286 B159：那颗「自动清理」按钮只展开行、不重发保留策略那一发', async () => {
    mountPanel(panelStubs())
    // 挂载那一读 fired getKbAskRetention 一次；这一发全文件只在挂载读一次
    await waitFor(() => expect(calls.retention).toBe(1), MOUNT_BUDGET)
    const before = { retention: calls.retention, sessions: calls.sessions }
    // 打开历史面板那行（那颗按钮的 onClick 会走 refreshSessions，sessions 涨一格；不动 retention）
    fireEvent.click(historyBtn())
    await waitFor(() => expect(calls.sessions).toBe(before.sessions + 1), MOUNT_BUDGET)
    // 点两次「自动清理」：先展开、再收起——两次都不该重发策略通道
    const btn = screen.getByRole('button', { name: RETENTION_WHAT })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0), MOUNT_BUDGET)
    fireEvent.click(screen.getByRole('button', { name: RETENTION_WHAT }))
    expect(calls.retention, '那行只是展开／收起、不重发保留策略那一发').toBe(before.retention)
  })
})

describe('③ 跨库漫游那一发：那句、让位与那颗键', () => {
  it('挂载失败 ⇒「暂无问答历史」让位给那句，那颗键点了有效', async () => {
    let fail = true
    mountRoam(roamStubs({
      listAllKbAskSessions: () => {
        calls.roam += 1
        return fail ? { ok: false, error: 'ROAM:漫游通道断了' } : [ROAM_ITEM]
      }
    }))
    await waitFor(() => expect(alerts()).toEqual([ROAM_FAIL]), MOUNT_BUDGET)
    expect(screen.queryByText(L('kb.roamEmpty'))).toBeNull()
    const before = calls.roam
    fail = false
    fireEvent.click(screen.getByTestId('kb-ask-roam-retry'))
    await waitFor(() => expect(calls.roam).toBe(before + 1), MOUNT_BUDGET)
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-漫游条目')
  })

  it('reject 面同一张脸', async () => {
    mountRoam(roamStubs({ listAllKbAskSessions: () => Promise.reject(new Error('漫游通道断了')) }))
    await waitFor(() => expect(alerts()).toEqual([NAMED(ROAM_WHAT, '漫游通道断了')]), MOUNT_BUDGET)
  })

  it('反向对照：读到 ⇒ 零 alert、条目与所属库名照常摆', async () => {
    mountRoam(roamStubs())
    await waitFor(() => expect(calls.roam).toBe(1), MOUNT_BUDGET)
    await waitFor(() => expect(bodyText()).toContain('PROBE-漫游条目'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(bodyText()).toContain('PROBE-KB')
    expect(screen.queryByTestId('kb-ask-roam-retry')).toBeNull()
  })

  it('搜索那一路失败也是同一张脸，且不清掉已在屏上的上一份结果', async () => {
    let searchFail = false
    mountRoam(roamStubs({
      searchAllKbAskSessions: () => (searchFail ? { ok: false, error: 'ROAM:搜索通道断了' } : [])
    }))
    await waitFor(() => expect(bodyText()).toContain('PROBE-漫游条目'), MOUNT_BUDGET)
    searchFail = true
    fireEvent.change(screen.getByPlaceholderText(L('kb.roamSearchPlaceholder')), { target: { value: '关键词' } })
    await waitFor(() => expect(alerts()).toEqual([NAMED(ROAM_WHAT, 'ROAM:搜索通道断了')]), MOUNT_BUDGET)
    expect(bodyText(), '这次没读到，但上一份读到的不该被吞掉').toContain('PROBE-漫游条目')
  })
})
