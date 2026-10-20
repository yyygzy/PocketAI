// @vitest-environment jsdom
// V4-Iter-230：§229 收口时点名的"同族下一处"——`KbDetail.loadDocs`（挂载那一读与每次 refresh）
// 原来是 `if (!hasIpcFailed(v)) setDocs(v)`：**判了**失败面，所以形状闸门看不见它，
// 但判过之后什么都不做 ⇒ 列表停在空数组，而界面上那句写的是
// 「暂无文档，上传文件或添加 URL/文本开始入库」——**把"没读到"说成"库里没有"**。
//
// 脸按手里有没有数据分（与 §222／§229 同一口径，不新造第三种说法）：
//  · 一条都没有 ⇒ 那句空态整个换成 `LoadFailNotice`（§222 那一形：没内容可留，就让位给原因）；
//  · 已有数据 ⇒ 本体照常（用户还能照着行操作），另挂一句 §229 那句「刷新失败：原因（界面停在上一份）」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, KbDocument } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const LOAD_FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const REFRESH_FAILED = (msg: string): string => L('common.refreshFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const rows = (): HTMLElement[] => screen.queryAllByText(/文档 d/)

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())
const traces = (): string[] => warns.filter((w) => w.startsWith('[ipc] '))

const kb = { id: 'kbA', name: '库甲', documentCount: 2 } as unknown as KnowledgeBase
const doc = (id: string): KbDocument =>
  ({
    id, kbId: 'kbA', source: `${id}.md`, sourceType: 'txt', title: `文档 ${id}`,
    chunkCount: 2, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1
  }) as unknown as KbDocument

/** 挂载 KbDetail；`listKbDocuments` 按第几次调用给值（可变 flag 让后面的用例能翻脸） */
function mountKb(list: (n: number) => unknown): { calls: () => number } {
  const state = { n: 0 }
  stubPocketai({
    listKbDocuments: () => {
      state.n += 1
      return list(state.n)
    },
    reindexKbDocument: () => ({ ok: true }),
    deleteKbDocument: () => ({ ok: true }),
    setKbDocEnabled: () => ({ ok: true }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    listProviders: () => [],
    listKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    reportPerf: () => undefined
  })
  mountWithProviders(<KbDetail kb={kb} onChanged={() => {}} />)
  return { calls: () => state.n }
}

describe('① 一条都没有又读不到 ⇒ 那句「暂无文档」整个让位', () => {
  it('resolve 的 {ok:false} ⇒ alert 是「读不到：库被占用」，且那句空态不在场', async () => {
    mountKb(() => ({ ok: false, error: '库被占用' }))
    await waitFor(() => expect(alerts()).toEqual([LOAD_FAILED('库被占用')]))
    expect(screen.queryByText(L('kb.noDocs'))).toBeNull()
  })

  it('真抛错 ⇒ 同一形、原因换成抛出来的原文，并留下一条 [ipc] 痕（标签与原来那句一致）', async () => {
    mountKb(() => Promise.reject(new Error('通道没接上')))
    await waitFor(() => expect(alerts()).toEqual([LOAD_FAILED('通道没接上')]))
    expect(traces()).toContain('[ipc] kb.listDocuments 失败: 通道没接上')
    expect(screen.queryByText(L('kb.noDocs'))).toBeNull()
  })

  it('反向对照：读到空清单 ⇒ 那才是"暂无文档"，不许冒 alert（空库与读失败是两件事）', async () => {
    mountKb(() => [])
    await waitFor(() => expect(screen.queryByText(L('kb.noDocs'))).not.toBeNull())
    expect(alerts()).toEqual([])
  })
})

/** 某一行的「重建」——第 0 行那颗（`noUncheckedIndexedAccess` 下取数组要显式收口，别写 `!`） */
const reindexFirst = (): HTMLElement => {
  const all = screen.getAllByText(L('kb.reindex'))
  expect(all.length, '行没挂出来').toBeGreaterThan(0)
  return all[0] as HTMLElement
}

describe('② 手里有数据时刷新失败 ⇒ 本体留着，另挂一句"停在上一份"', () => {
  it('挂载成功两条、随后 refresh 读不到 ⇒ 两行还在，alert 是那句「刷新失败：…（界面停在上一份）」', async () => {
    let failing = false
    mountKb(() => (failing ? { ok: false, error: '库被占用' } : [doc('d1'), doc('d2')]))
    await waitFor(() => expect(rows()).toHaveLength(2))
    failing = true
    fireEvent.click(reindexFirst())
    await waitFor(() => expect(alerts()).toEqual([REFRESH_FAILED('库被占用')]))
    expect(rows(), '不许把已经拿到的列表换成一句提示').toHaveLength(2)
    expect(screen.queryByText(L('kb.noDocs'))).toBeNull()
  })

  it('后来读到了 ⇒ 那句消失（残留的原因不许把数据压住）', async () => {
    let failing = false
    mountKb(() => (failing ? { ok: false, error: '库被占用' } : [doc('d1'), doc('d2')]))
    await waitFor(() => expect(rows()).toHaveLength(2))
    failing = true
    fireEvent.click(reindexFirst())
    await waitFor(() => expect(alerts()).toEqual([REFRESH_FAILED('库被占用')]))
    failing = false
    fireEvent.click(reindexFirst())
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(rows()).toHaveLength(2)
  })
})

describe('③ 接线（源码区域断言）', () => {
  const src = (): string =>
    fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/modules/knowledge/KnowledgeModule.tsx'), 'utf-8')

  it('loadDocs 两条失败面都交原因，成功分支先清掉残留再写数据', () => {
    const code = src().replace(/\r\n/g, '\n')
    const from = 'const loadDocs = useCallback(() => window.pocketai.listKbDocuments(kb.id)'
    const to = '\n  useEffect(() => {\n    loadDocs()'
    expect(code.split(from).length - 1, '起点锚命中次数不对').toBe(1)
    expect(code.split(to).length - 1, '终点锚命中次数不对').toBe(1)
    const region = code.slice(code.indexOf(from), code.indexOf(to))
    expect(region).toContain("setReadErr(ipcFailText(v, t('common.unknownError')))")
    expect(region).toContain("setReadErr(errText(e, t('common.unknownError')))")
    expect(region).toContain('setReadErr(null)')
    expect(region).toContain('setDocs(v)')
    expect(region).toContain("logIpcError('kb.listDocuments', e)")
  })

  it('那句「暂无文档」必须被"没读到"挡住（否则永远同时挂着两句）', () => {
    expect(src()).toContain('{docs.length === 0 && !readErr && (')
  })
})
