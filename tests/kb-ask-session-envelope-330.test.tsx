// 问答历史那一读有三种到货（V4-Iter-330）
//
// `KB_ASK_SESSION_GET` 的 handler 直发记录（`knowledge.ts:261`），preload 原先只写
// `Promise<KbAskSessionRecord | null>` ⇒ safeHandle 把 zod 拒绝／库错折成 `{ok:false,…}` 时它是**真值**，
// 那句 `if (!rec)` 拦不住：`setSessionId(rec.id)` 与 `msgsRef.current = rec.messages` 收的是 undefined，
// 而 `msgs.map(...)`（KbAskPanel:732）在渲染期就抛——根层错误边界接住＝整块屏没了（R 档）。
// 现在两路各自分开：读不到（失败信封）报错误原文、真不在了（null）刷新列表，成功照常回放。
//
// 夹具抄 §311 那份问答历史挂载用例（同一批 pend/answer 队列，不靠 sleep）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbAskSessionMeta, KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

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
const flush = async (fn: () => void): Promise<void> => {
  await act(async () => {
    fn()
    await settle()
  })
}

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'P1', baseUrl: 'https://example.invalid/v1',
  apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

const meta = (id: string): KbAskSessionMeta =>
  ({ id, kbId: 'kb1', title: `会话 ${id}`, messageCount: 1, providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1 }) as unknown as KbAskSessionMeta

const record = (id: string, content: string) =>
  ({
    id, kbId: 'kb1', title: `会话 ${id}`, messages: [{ role: 'user', content }],
    providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1
  }) as unknown as KbAskSessionMeta

const KB = { id: 'kb1', name: 'K', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

let sessionListCalls: number
/** 挂载并展开面板后的提示快照（成功那趟要按「一句也没多出来」判，而不是按「零提示」判） */
let baseline: string[]

beforeEach(() => {
  q = {}
  sessionListCalls = 0
  baseline = []
  stubPocketai({
    listProviders: () => [PROVIDER],
    listKbAskSessions: () => {
      sessionListCalls += 1
      return [meta('sA'), meta('sB')]
    },
    searchKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    getKbAskSession: (id: string) => pend(`sess:${id}`),
    saveKbAskSession: () => ({ ok: true }),
    kbAsk: () => ({ requestId: 'r-1' }),
    kbAskAbort: () => ({ ok: true }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    exportKbAskSession: () => ({ ok: true }),
    reportPerf: () => undefined
  })
})

/** 展开历史面板并点会话 id（导航走一遍，别猜） */
const openSession = async (id: string): Promise<void> => {
  mountWithProviders(<KbAskPanel kb={KB} />)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L('kb.askHistory')}`) }))
  await waitFor(() => expect(screen.getByText(`会话 ${id}`)).toBeTruthy())
  fireEvent.click(screen.getByText(`会话 ${id}`))
  await waitFor(() => expect(q[`sess:${id}`]?.length).toBeTruthy())
  baseline = toasts()
}

describe('§330 问答历史那一读：三种到货分开判', () => {
  it('读不到（{ok:false}）⇒ 说错误原文，且那一屏还在（改前把 undefined 写进 state，渲染期就抛）', async () => {
    await openSession('sA')
    await flush(() => answer('sess:sA', { ok: false, error: '库正被占用', ipcCode: 'SQL_BUSY' }))

    expect(baseline.join('|')).not.toContain('库正被占用')
    expect(toasts().join('|')).toContain('库正被占用')
    // 没崩的判据：历史面板那条会话行还站得住（改前整块屏被错误边界换掉，这里一个字都取不到）
    expect(screen.getByText('会话 sA')).toBeTruthy()
    expect(screen.getByText('会话 sB')).toBeTruthy()
  })

  it('真不在了（null）⇒ 不谎报「读不到」，走刷新列表', async () => {
    const before = sessionListCalls
    await openSession('sA')
    await flush(() => answer('sess:sA', null))

    expect(toasts().join('|')).not.toContain('库正被占用')
    expect(sessionListCalls).toBeGreaterThan(before)
  })

  it('正向对照：成功那趟照常把历史消息画出来、不发提示', async () => {
    await openSession('sA')
    await flush(() => answer('sess:sA', record('sA', '甲的历史提问')))

    expect(screen.getByText('甲的历史提问')).toBeTruthy()
    expect(toasts()).toEqual(baseline)
  })
})
