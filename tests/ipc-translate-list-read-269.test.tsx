// V4-Iter-269：第四面静默名单第二簇——翻译页余下的三发清单读。
//
// 名单现查 36 条里翻译页占三条，而且是同一屏：
//  · `TranslateModule.tsx:140`（挂载读历史）与 `:172`（**翻译成功后**刷新历史）——两发写同一份屏上数据，
//    过去失败侧都是 `if (!hasIpcFailed(v)) setHistory(v)`＝什么都不做 ⇒ 留着上一份历史且零字，
//    "刚翻完那条没进列表"看着像"没翻成"；
//  · `:141`（挂载读术语表）——失败时「术语表（0 条）」那颗按钮与面板里的「还没有术语条目」
//    把通道故障演成"你一个术语都没录"。
//
// 三条形状决定（按这一屏自己的形状定，不是套上一批模板）：
//  ① 历史那两发**共用一张脸**：同一份数据的两次取分两句就是"同一件事说两遍"；
//     §268 的"一发挂掉不许替另一发闭嘴"针对的是**不同**数据（这里历史与术语表就是不同数据，各一句）。
//  ② 每份数据一颗重试键（按选定口径）：这一屏**没有天然重发点**——`reloadHistory` 只在翻译成功后被调，
//     屏上没有刷新键，挂载那发失败后只能重进模块 ⇒ 不给键就成了没出路的一句话。
//  ③ 术语表那句与那颗键是**同一份 JSX**，遮罩外（工具条）与遮罩内（面板）二选一渲染 ⇒
//     同一时刻屏上只有一句、一颗键（§268 第 15 条：不该造机关的地方别造第二颗）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { GlossaryTerm, ProviderRecord, TranslationRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''
const buttons = (): HTMLElement[] => Array.from(document.querySelectorAll('button'))
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const REASON = 'IO:通道断了'
const HISTORY_WHAT = L('translate.history.title')
const GLOSSARY_WHAT = L('common.glossaryList')

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
} as unknown as ProviderRecord

/** 桩按真形状写死（§255 那条：混着桩会把判据落在错的形状上） */
const HISTORY_ROW: TranslationRecord = {
  id: 'h1', sourceText: 'PROBE-历史', targetText: 'PROBE-译文', sourceLang: 'zh', targetLang: 'en',
  style: 'standard', providerId: 'p1', providerName: 'PROBE-PROVIDER', model: 'm1', createdAt: 1700000000000
}
const GLOSSARY_ROW: GlossaryTerm = { id: 'g1', sourceTerm: 'PROBE-术语', targetTerm: 'PROBE-译法', createdAt: 1700000000000 }

const baseStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listTranslations: () => [],
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  translate: () => new Promise(() => {}),
  abortTranslate: () => ({ ok: true }),
  ...over
})

async function mountTranslate(over: Record<string, (...a: any[]) => unknown> = {}): Promise<void> {
  stubPocketai(baseStubs(over))
  mountWithProviders(<TranslateModule />)
  // 见证选"到达这一屏"那一下：服务商下拉填上了才算挂载那三发都走完
  await waitFor(() => expect(bodyText()).toContain('PROBE-PROVIDER'), MOUNT_BUDGET)
}

/** 「术语表（n）／术语表管理」那颗管理键 */
const manageButton = (): HTMLElement => {
  const b = buttons().find(
    (x) => (x.textContent ?? '').trim() === L('translate.glossary.title') || /^术语表（\d+）$/.test((x.textContent ?? '').trim())
  )
  expect(b, '管理术语表那颗键在场').toBeTruthy()
  return b!
}

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

describe('① 历史那一读：失败说一句、读到即收回，不许演成"还没翻过"', () => {
  it('resolve 的失败对象 ⇒ 那句上屏，「还没有翻译记录」让位', async () => {
    await mountTranslate({ listTranslations: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(HISTORY_WHAT, REASON)]))
    expect(bodyText(), '把"读不到"演成"一条都没有"').not.toContain(L('translate.history.empty'))
  })

  it('reject ⇒ 同一张脸（两条失败路都要写原因）', async () => {
    await mountTranslate({ listTranslations: () => Promise.reject(new Error('REJECT-历史')) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(HISTORY_WHAT, 'REJECT-历史')]))
  })

  it('反向对照：读到 ⇒ 条目上屏、零 alert（不把成功说成失败）', async () => {
    await mountTranslate({ listTranslations: () => [HISTORY_ROW] })
    await waitFor(() => expect(bodyText()).toContain('PROBE-历史'), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain(L('translate.history.empty'))
  })

  it('那颗重试键：先失败再成功 ⇒ 那句随这一发落定自己退场、条目上屏', async () => {
    let fail = true
    await mountTranslate({ listTranslations: () => (fail ? { ok: false, error: REASON } : [HISTORY_ROW]) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(HISTORY_WHAT, REASON)]))
    fail = false
    fireEvent.click(screen.getByTestId('translate-history-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain('PROBE-历史')
  })
})

describe('② 术语表那一读：「（0 条）」与面板空态两张谎脸都要换', () => {
  it('失败 ⇒ 按钮不再报条数，工具条那句上屏；键在 alert 盒子外面 ⇒ 那句可整值比', async () => {
    await mountTranslate({ listGlossary: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(GLOSSARY_WHAT, REASON)]))
    expect(manageButton().textContent, '按钮上的数字是那一读喂出来的，读不到就不许报条数').not.toContain('0')
    expect(manageButton().textContent?.trim()).toBe(L('translate.glossary.title'))
  })

  it('反向对照：读到 ⇒ 按钮照旧报条数、零 alert', async () => {
    await mountTranslate({ listGlossary: () => [GLOSSARY_ROW] })
    await waitFor(() => expect(bodyText()).toContain(L('translate.glossary.manage').replace('{n}', '1')), MOUNT_BUDGET)
    expect(alerts()).toEqual([])
  })

  it('失败后打开面板 ⇒ 面板里「还没有术语条目」让位；**同一时刻只有一句、一颗键**（遮罩外那份收进面板）', async () => {
    await mountTranslate({ listGlossary: () => ({ ok: false, error: REASON }) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(GLOSSARY_WHAT, REASON)]))
    fireEvent.click(manageButton())
    await waitFor(() => expect(bodyText()).toContain(L('translate.glossary.title')), MOUNT_BUDGET)
    expect(bodyText(), '面板里把"读不到"演成"你一个都没录"').not.toContain(L('translate.glossary.empty'))
    expect(alerts(), '那句在遮罩内外各挂一次就成了两句').toEqual([FAILED(GLOSSARY_WHAT, REASON)])
    expect(screen.getAllByTestId('translate-glossary-retry')).toHaveLength(1)
  })

  it('那颗重试键：先失败再成功 ⇒ 那句退场、按钮回到报条数', async () => {
    let fail = true
    await mountTranslate({ listGlossary: () => (fail ? { ok: false, error: REASON } : [GLOSSARY_ROW]) })
    await waitFor(() => expect(alerts()).toEqual([FAILED(GLOSSARY_WHAT, REASON)]))
    fail = false
    fireEvent.click(screen.getByTestId('translate-glossary-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(bodyText()).toContain(L('translate.glossary.manage').replace('{n}', '1'))
  })
})

describe('③ 逐发点名：一发挂掉不许替另一发闭嘴、也不许替另一发重发', () => {
  it('历史挂、术语表读到 ⇒ 只有历史那句，术语表按钮照常报条数', async () => {
    await mountTranslate({
      listTranslations: () => ({ ok: false, error: REASON }),
      listGlossary: () => [GLOSSARY_ROW]
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(HISTORY_WHAT, REASON)]))
    expect(bodyText()).toContain(L('translate.glossary.manage').replace('{n}', '1'))
  })

  it('术语表挂、历史读到 ⇒ 只有术语表那句，历史条目照常上屏', async () => {
    await mountTranslate({
      listTranslations: () => [HISTORY_ROW],
      listGlossary: () => ({ ok: false, error: REASON })
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(GLOSSARY_WHAT, REASON)]))
    expect(bodyText()).toContain('PROBE-历史')
  })

  it('点术语表那颗键不会去重发历史那一发', async () => {
    let historyCalls = 0
    let glossaryFails = true
    await mountTranslate({
      listTranslations: () => {
        historyCalls += 1
        return [HISTORY_ROW]
      },
      listGlossary: () => {
        if (glossaryFails) return { ok: false, error: REASON }
        return [GLOSSARY_ROW]
      }
    })
    await waitFor(() => expect(alerts()).toEqual([FAILED(GLOSSARY_WHAT, REASON)]))
    const before = historyCalls
    glossaryFails = false
    fireEvent.click(screen.getByTestId('translate-glossary-retry'))
    await waitFor(() => expect(alerts()).toEqual([]), MOUNT_BUDGET)
    expect(historyCalls, '术语表那颗键只重发术语表这一发').toBe(before)
  })
})
