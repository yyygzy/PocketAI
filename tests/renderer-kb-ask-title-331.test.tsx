// §331 K6：问答会话的标题归用户那份，追问落库不许把它重算回首问截断
//
// `persistSession` 是**全量 upsert**（单写路径），改前每次都用 `sessionTitleFrom(首条 user 消息)` 现算标题
// ⇒ 用户在历史面板里改好名字，回到那条会话再追一句，名字就被静默还原（列表里看着像改名没生效）。
// 现在面板留一份"这一条的标题"：点开历史时取记录自带的、改名时换成新的、新对话才按首问算。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import { sessionTitleFrom } from '../src/shared/kb-ask-session'
import type { KbAskSessionMeta, KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FIRST_A = '甲的历史提问很长很长很长很长很长很长很长很长'

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'P1', baseUrl: 'https://example.invalid/v1',
  apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

const KB = { id: 'kb1', name: 'K', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

const meta = (id: string, title: string): KbAskSessionMeta =>
  ({ id, kbId: 'kb1', title, messageCount: 1, providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1 }) as unknown as KbAskSessionMeta

const record = (id: string, title: string, content: string) =>
  ({ id, kbId: 'kb1', title, messages: [{ role: 'user', content }], providerId: 'p1', model: 'm1', createdAt: 1, updatedAt: 1 })

let saved: Array<{ id: string; title: string }>
/** 会话名的事实来源（改名那一发写回这里，列表与记录都从它取——不然改名在桩里不落地） */
let titles: Map<string, string>

beforeEach(() => {
  saved = []
  titles = new Map([['sA', '我自己改过的名字'], ['sB', '乙的历史会话']])
  stubPocketai({
    listProviders: () => [PROVIDER],
    // sA 是"用户早就改过名"的那条：列表与记录里的标题一致，都跟首问截断不同
    listKbAskSessions: () => [meta('sA', titles.get('sA')!), meta('sB', titles.get('sB')!)],
    searchKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    getKbAskSession: (id: string) => record(id, titles.get(id)!, id === 'sA' ? FIRST_A : '乙的提问'),
    saveKbAskSession: (rec: { id: string; title: string }) => {
      saved.push({ id: rec.id, title: rec.title })
      return { ok: true }
    },
    renameKbAskSession: (id: string, title: string) => {
      titles.set(id, title)
      return { ok: true }
    },
    kbAsk: () => ({ requestId: 'r-1' }),
    kbAskAbort: () => ({ ok: true }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    exportKbAskSession: () => ({ ok: true }),
    reportPerf: () => undefined
  })
})

const openHistory = async (label: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L('kb.askHistory')}`) }))
  await waitFor(() => expect(screen.getByText(label)).toBeTruthy())
}

/** provider 那发是异步落的（没选上之前 `ask()` 直接 return；那颗「发送」只由输入框是否为空决定，
 *  所以就绪判据要取第一枚下拉＝provider，不能取按钮的 disabled） */
const sendReady = async (): Promise<void> => {
  await waitFor(() => expect((document.querySelectorAll('select')[0] as HTMLSelectElement).value).toBeTruthy())
}

/** 问输入框（这一屏只有它一个 textarea）里敲一句并按 Enter 发送 */
const askAnother = async (text = '再追一句'): Promise<void> => {
  await sendReady()
  const area = document.querySelector('textarea') as HTMLTextAreaElement
  fireEvent.change(area, { target: { value: text } })
  fireEvent.keyDown(area, { key: 'Enter' })
  await waitFor(() => expect(saved.length).toBeGreaterThan(0))
}

describe('§331 K6 追问落库不许把用户改过的会话名冲掉', () => {
  it('点开改过名的历史会话再追问 ⇒ 落库的标题还是那一个', async () => {
    mountWithProviders(<KbAskPanel kb={KB} />)
    await openHistory('我自己改过的名字')
    fireEvent.click(screen.getByText('我自己改过的名字'))
    await waitFor(() => expect(screen.getByText(FIRST_A)).toBeTruthy())

    await askAnother()

    expect(saved[0]!.id).toBe('sA')
    expect(saved[0]!.title).toBe('我自己改过的名字')
    // 反向钉：改前写的就是这个截断名 ⇒ 它不许出现在落库那一发里
    expect(saved[0]!.title).not.toBe(sessionTitleFrom(FIRST_A))
  })

  it('正向对照：新对话第一次落库仍按首问命名（这条口径不许被改坏）', async () => {
    mountWithProviders(<KbAskPanel kb={KB} />)
    await askAnother()

    expect(saved[0]!.title).toBe(sessionTitleFrom('再追一句'))
  })

  it('当场改当前那条的名字 ⇒ 之后的追问沿用新名', async () => {
    mountWithProviders(<KbAskPanel kb={KB} />)
    await openHistory('乙的历史会话')
    fireEvent.click(screen.getByText('乙的历史会话'))
    // 点开一条会话会收掉历史面板（loadSession 末尾 setShowHistory(false)）；
    // 这一步必须**等它收完**再点第二次——否则那一次点击只是把还开着的面板关掉（我第一版就踩在这里）
    await waitFor(() => expect(screen.getByText('乙的提问')).toBeTruthy())
    await waitFor(() => expect(screen.queryByText('乙的历史会话')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${L('kb.askHistory')}`) }))
    await waitFor(() => expect(screen.getByText('乙的历史会话')).toBeTruthy())
    // 行内那颗 ✎ 的 aria-label 才是 chat.rename（头部那颗只有 title 属性）；[1]＝列表里第二条＝sB
    fireEvent.click(screen.getAllByLabelText(L('chat.rename'))[1]!)
    const input = (await screen.findByDisplayValue('乙的历史会话')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '乙，改过了' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('乙，改过了')).toBeTruthy())

    await askAnother()
    expect(saved[saved.length - 1]!.title).toBe('乙，改过了')
  })
})
