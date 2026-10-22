// V4-Iter-263：第五面第一簇——「判了、也只 `return`」那六处清单读，失败侧现在自己说话。
//
// 这一族的形状与 §259～§262 不同：它们**没有**把失败对象当数据用（不崩、不摆假 id），第四面也判它们"接管了"
// （流程停了）。缺的是下一层：成功那支要写屏，失败那支什么都不写 ⇒ 那份数据停在初值，
// 于是"读不到"长成"这家服务商都没有"。开工先按 §261 的规矩探针实测（临时用例跑完即删）三档读数：
//  · 绘图页／翻译页／知识库问答／浮窗的 `listProviders` 回 `{ok:false}` ⇒ 下拉里是
//    「还没有可用的服务商」（`image.noProvider`／`translate.noProvider`／`popup.noProvider`）或只剩「请选择」
//    （`kb.pleaseSelect`）——**把通道故障演成"你还没配"**，而这几屏的生成／翻译／问答按钮全灰着，用户只会去新建服务商。
//  · 浮窗的 `listAssistants` 回 `{ok:false}` ⇒ `assistant` 停在 `null`，而 `handleSend` 第一句是
//    `if (!assistant) return` ⇒ **发送键按下去毫无反应**（探针读数：零提示、零请求、按钮不转圈）。
//  · 浮窗点「拉取模型」失败 ⇒ 按钮回到可点、下拉仍空 ⇒ 看着像"这家没有模型"。
//
// 收口沿用既有的脸，不另立：§222 的 `LoadFailNotice` ＋ §259 的逐发点名（`what` 槽位），
// 空态在对应那句在场时**让位**（§254 手法）。两个口径决定在这里定死：
//  · 键从 `agent.providersList`／`agent.assistantsList` 挪进 **`common.*`**（同一个界面名词现在五块屏在用，
//    §153"按钮名不再手抄"是同一条纪律），并新增 `common.modelsList`；
//  · reject 面与 resolve 的失败对象**同一张脸**（§262），且不再把 reject 裸交给 `reportIpcError`——
//    那几发是挂载读，一条会消失的 toast 等于没说。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ImageModule } from '../src/renderer/src/modules/image/ImageModule'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const bodyText = (): string => document.body.textContent ?? ''

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const KB = { id: 'kb1', name: 'PROBE-KB', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase

const PROVIDERS_NAMED = (): string => NAMED(L('common.providersList'), 'PROV:服务商通道炸了')
const ASSISTANTS_NAMED = (): string => NAMED(L('common.assistantsList'), 'ASST:助手通道炸了')
const MODELS_NAMED = (): string => NAMED(L('common.modelsList'), 'MODELS:模型通道炸了')

beforeEach(() => {
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
  // 浮窗的 providerId 初值来自 localStorage（`LS_PROVIDER`），上一用例留的值会把"下拉空"变成"选了那家"
  localStorage.clear()
})

// ───────── ① 绘图页 ─────────

const imageStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listImages: () => [],
  abortImage: () => ({ ok: true }),
  ...over
})

describe('① 绘图页那一发服务商读：三种到货分得开', () => {
  it('回 {ok:false} ⇒ 那句上屏、「还没有可用的服务商」让位、屏上仍有内容', async () => {
    stubPocketai(imageStubs({ listProviders: () => ({ ok: false, error: 'PROV:服务商通道炸了' }) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(alerts()).toContain(PROVIDERS_NAMED()))
    expect(screen.queryByText(L('image.noProvider'))).toBeNull()
    // 立项负向：这一屏不该因为一发读挂掉就整块消失
    expect(bodyText()).toContain(L('image.gallery'))
  })

  it('reject 面 ⇒ 同一句用抛出的原文（旧写法只留一条 [ipc] 留痕）', async () => {
    stubPocketai(imageStubs({ listProviders: () => Promise.reject(new Error('服务商通道炸了')) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(alerts()).toContain(NAMED(L('common.providersList'), '服务商通道炸了')))
  })

  it('反向对照：读到一家 ⇒ 没有 alert，画廊空态照旧（那一发不牵动别的面板）', async () => {
    stubPocketai(imageStubs())
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(bodyText()).toContain('PROVIDER'))
    expect(alerts()).toEqual([])
    expect(bodyText()).toContain(L('image.empty'))
  })
})

// ───────── ② 翻译页 ─────────

const translateStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listTranslations: () => [],
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  ...over
})

describe('② 翻译页那一发：那句"还没有可用的服务商"不许替通道故障说话', () => {
  it('回 {ok:false} ⇒ 点名服务商那句、空态让位', async () => {
    stubPocketai(translateStubs({ listProviders: () => ({ ok: false, error: 'PROV:服务商通道炸了' }) }))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(alerts()).toContain(PROVIDERS_NAMED()))
    expect(screen.queryByText(L('translate.noProvider'))).toBeNull()
  })

  it('反向对照：读到 ⇒ 零 alert，且下拉里是那家服务商的名字', async () => {
    stubPocketai(translateStubs())
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(bodyText()).toContain('PROVIDER'))
    expect(alerts()).toEqual([])
  })
})

// ───────── ③ 知识库问答 ─────────

const kbStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
  listKbAskSessions: () => [],
  searchKbAskSessions: () => [],
  onKbAskChunk: () => () => {},
  onKbAskDone: () => () => {},
  onKbAskError: () => () => {},
  ...over
})

describe('③ 知识库问答那一发：失败不是"你自己还没选"', () => {
  it('回 {ok:false} ⇒ 那句上屏，屏上仍有内容（不是整块不出现）', async () => {
    stubPocketai(kbStubs({ listProviders: () => ({ ok: false, error: 'PROV:服务商通道炸了' }) }))
    mountWithProviders(<KbAskPanel kb={KB} />)
    await waitFor(() => expect(alerts()).toContain(PROVIDERS_NAMED()))
    expect(bodyText().length).toBeGreaterThan(0)
  })

  it('反向对照：读到 ⇒ 零 alert（自动选中那家，「请选择」不再出现）', async () => {
    stubPocketai(kbStubs())
    mountWithProviders(<KbAskPanel kb={KB} />)
    await waitFor(() => expect(bodyText()).toContain('PROVIDER'))
    expect(alerts()).toEqual([])
  })
})

// ───────── ④ 浮窗：三发读各说各的 ─────────

const popupStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [{ ...PROVIDER, models: [] }],
  listAssistants: () => [{ id: 'a1', name: '通用问答', isBuiltin: true }],
  getPopupPayload: () => null,
  onPopupPayload: () => () => {},
  fetchModels: () => ['m1'],
  onChatChunk: () => () => {},
  onChatDone: () => () => {},
  onChatError: () => () => {},
  createConversation: () => ({ id: 'cv1' }),
  sendMessage: () => ({ ok: true }),
  abortChat: () => ({ ok: true }),
  hidePopup: () => ({ ok: true }),
  ...over
})

describe('④ 浮窗那三发：逐发点名，且拉取模型成功后那句自己退场', () => {
  it('只服务商那发挂 ⇒ 只有它那一句，助手那句不许顺带冒（逐发点名）', async () => {
    stubPocketai(popupStubs({ listProviders: () => ({ ok: false, error: 'PROV:服务商通道炸了' }) }))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(alerts()).toContain(PROVIDERS_NAMED()))
    expect(alerts()).not.toContain(ASSISTANTS_NAMED())
    expect(screen.queryByText(L('popup.noProvider'))).toBeNull()
  })

  it('只助手那发挂 ⇒ 那句上屏（这一发过去是"发送键按下去毫无反应"）', async () => {
    stubPocketai(popupStubs({ listAssistants: () => ({ ok: false, error: 'ASST:助手通道炸了' }) }))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(alerts()).toContain(ASSISTANTS_NAMED()))
    expect(alerts()).not.toContain(PROVIDERS_NAMED())
  })

  it('两发都挂 ⇒ 两句各说各的，屏上仍有内容（浮窗不该整块空）', async () => {
    stubPocketai(popupStubs({
      listProviders: () => ({ ok: false, error: 'PROV:服务商通道炸了' }),
      listAssistants: () => ({ ok: false, error: 'ASST:助手通道炸了' })
    }))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(alerts()).toEqual([PROVIDERS_NAMED(), ASSISTANTS_NAMED()]))
    expect(bodyText().length).toBeGreaterThan(0)
  })

  it('点「拉取模型」失败 ⇒ 那句上屏；再点一次成功 ⇒ 那句必须退场（陈旧谎报不能留着）', async () => {
    let fail = true
    stubPocketai(popupStubs({
      fetchModels: () => (fail ? { ok: false, error: 'MODELS:模型通道炸了' } : ['m9'])
    }))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(bodyText()).toContain('PROVIDER'))
    const btn = screen.getByText(L('agent.fetchModels'))
    fireEvent.click(btn)
    await waitFor(() => expect(alerts()).toContain(MODELS_NAMED()))
    fail = false
    fireEvent.click(screen.getByText(L('agent.fetchModels')))
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(bodyText()).toContain('m9')
  })
})
