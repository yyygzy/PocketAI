// @vitest-environment jsdom
// V4-Iter-355：「读不到」那一族的最后一批——十处全部真挂载点到（每颗键都有用例按过一次，第 24 条那条纪律）。
//
// 这一批的分诊尺子与前几批同一条（"这一发有没有用户在这屏上命令得动的重读入口"），特别之处是**每一处都得先抽 loader**：
// 那十发的读写全写在挂载 effect 的体内联 `.then` 里，键直接指 effect 是点不动的（§350 第二档）。
// 本文件要演的就是"抽完之后两件事都成立"：
//   · 行为没变——挂载那一发照旧发得出（各条第 1 步的 callsOf===1 就是这条，旧夹具形状照抄 `ipc-jump-read-263`）；
//   · 那颗键真有牙——按下去真再发一发，到货后那句与那颗键一起撤、脸换成本体。
// 另两处是本批新改的机关，特别钉住：绘图页预览那颗原来靠闭包 `alive` 挡迟到写，抽成 loader 后换成代次判据（同一处第二条用例演）；
// 浮窗那两张脸是同一屏两份数据各自失败 ⇒ 两句配两颗键，各点各的通道（§351 口径）。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { ImageModule } from '../src/renderer/src/modules/image/ImageModule'
import KbAskPanel from '../src/renderer/src/modules/knowledge/KbAskPanel'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { TranslateModule } from '../src/renderer/src/modules/translate/TranslateModule'
import { FirstRunWizard } from '../src/renderer/src/modules/wizard/FirstRunWizard'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ImageListItem, KbDocument, KnowledgeBase, ProviderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const RETRY = L('agent.retryRead')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const FAIL = (msg: string): { ok: false; error: string } => ({ ok: false, error: msg })

const PROVIDER: ProviderRecord = {
  id: 'p1', type: 'openai-compatible', name: 'PROBE-PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const KB = { id: 'kb1', name: 'PROBE-KB', embeddingModel: 'e', topK: 5, topN: 5 } as unknown as KnowledgeBase
const IMG: ImageListItem = {
  id: 'g1', prompt: '一只戴帽子的猫', model: 'img-model', providerId: 'p1', providerName: 'PROBE',
  size: '1024x1024', fileName: 'images/2026-10/g1.png', bytes: 2048, createdAt: 1730000000000,
  thumbnailDataUrl: null
} as unknown as ImageListItem

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

beforeEach(() => {
  localStorage.clear()
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

// ───────── ① 绘图页：服务商与画廊那两发（同一屏、各说各的、各一颗键） ─────────
const imageStubs = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listImages: () => [IMG],
  abortImage: () => ({ ok: true }),
  getImageFile: () => ({ ok: true, dataUrl: 'data:image/png;base64,AA' }),
  ...over
})

describe('绘图页：服务商那一发读不到 ⇒ 下拉空着不是"一家都没有"，那颗键按下去真再发一发', () => {
  it('失败脸有键（在 alert 盒子外）⇒ 按下去真多发一发 listProviders ⇒ 到货后那句与那颗键一起撤', async () => {
    let fail = true
    stubPocketai(imageStubs({ listProviders: () => (fail ? FAIL('PROV:通道炸了') : [PROVIDER]) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(callsOf('listProviders')).toBe(1))
    await settle()
    expect(alerts()).toEqual([NAMED(L('common.providersList'), 'PROV:通道炸了')])
    const key = screen.getByTestId('image-providers-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)
    // 那一支没有出口的另一半证据：这一屏此刻只有刚造的那颗键，「生成」那颗键按下去走的是 handleGenerate
    expect(document.querySelectorAll('[data-testid$="-read-retry"]').length, '这一屏只有这一颗重试键').toBe(1)
    expect(
      Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes(L('image.generate'))),
      '「生成」那颗键在场'
    ).toBeTruthy()

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listProviders')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('image-providers-read-retry')).toBeNull()
  })
})

describe('绘图页：画廊那一发读不到 ⇒ 角标是「?」不是 0，那颗键按下去真再发一发 listImages', () => {
  it('失败脸有键 ⇒ 按下去真多发一发 ⇒ 到货后那句撤、清单上屏', async () => {
    let fail = true
    stubPocketai(imageStubs({ listImages: () => (fail ? FAIL('GAL:通道炸了') : [IMG]) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(callsOf('listImages')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('GAL:通道炸了')])
    const key = screen.getByTestId('image-gallery-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listImages')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('image-gallery-read-retry')).toBeNull()
    expect(screen.getByText('一只戴帽子的猫')).toBeTruthy()
  })
})

// ───────── ② 预览弹窗：本批把闭包 alive 换成代次判据的那一处 ─────────
describe('绘图页·预览：读不到那张脸只有一颗「关闭」陪它 ⇒ 键按下去真再发一发 getImageFile', () => {
  it('失败脸上有键 ⇒ 按下去真多发一发 ⇒ 那句撤、图上屏', async () => {
    let fail = true
    stubPocketai(imageStubs({ getImageFile: () => (fail ? FAIL('FILE:通道炸了') : { ok: true, dataUrl: 'data:image/png;base64,AA' }) }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(screen.getByText('一只戴帽子的猫')).toBeTruthy())
    fireEvent.click(screen.getByText('一只戴帽子的猫'))
    await waitFor(() => expect(callsOf('getImageFile')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('FILE:通道炸了')])
    const key = screen.getByTestId('image-preview-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getImageFile')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('image-preview-read-retry')).toBeNull()
    expect(screen.getByAltText('一只戴帽子的猫')).toBeTruthy()
  })

  // 本批这一处改了机关（闭包 alive ⇒ 组件级代次），所以单独钉一条"迟到那一发不许写回"：
  // 真机路径＝第一张那张图还在读（大文件／磁盘慢）⇒ 用户 Esc 关窗 ⇒ 马上点开第二张 ⇒ 第一张那发才到货。
  // 原来那份靠闭包 alive 挡不住：那颗重试键与换图各用自己的闭包，只有组件级的号能把两边都盖住。
  it('第一张还在飞时关掉窗口、点开第二张 ⇒ 第一张迟到到货也不许把图写进第二张的窗里', async () => {
    const SECOND = 'data:image/png;base64,SECOND'
    const STALE = 'data:image/png;base64,STALE'
    let resolveFirst: (v: { ok: true; dataUrl: string }) => void = () => {}
    const first = new Promise<{ ok: true; dataUrl: string }>((r) => { resolveFirst = r })
    const g2 = { ...IMG, id: 'g2', prompt: '另一张戴帽子的狗' } as unknown as ImageListItem
    stubPocketai(imageStubs({
      listImages: () => [IMG, g2],
      getImageFile: (id: unknown) => (id === 'g1' ? first : { ok: true, dataUrl: SECOND })
    }))
    mountWithProviders(<ImageModule />)
    await waitFor(() => expect(screen.getByText('一只戴帽子的猫')).toBeTruthy())

    fireEvent.click(screen.getByText('一只戴帽子的猫'))
    await waitFor(() => expect(callsOf('getImageFile')).toBe(1))
    expect(callsOf('getImageFile'), '还在飞时不该有多发').toBe(1)

    // Esc 关窗（第 3 步：号往前推＝作废在飞那一发），再点开第二张
    fireEvent.keyDown(window, { key: 'Escape' })
    await settle()
    fireEvent.click(screen.getByText('另一张戴帽子的狗'))
    await waitFor(() => expect(callsOf('getImageFile')).toBe(2))
    await settle()
    const img = screen.getByAltText('另一张戴帽子的狗') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(SECOND)

    // 第一张那发此刻才到货——它认的是自己的号，写不进第二张的窗
    resolveFirst({ ok: true, dataUrl: STALE })
    await settle()
    expect((screen.getByAltText('另一张戴帽子的狗') as HTMLImageElement).getAttribute('src'), '迟到那一发不许顶掉当前这张').toBe(SECOND)
    expect(alerts(), '迟到那一发也不许留下那句').toEqual([])
  })
})

// ───────── ③ 知识库问答：provider 那一发（抽 loader 时把闭包 alive 换成 ref） ─────────
const kbStubs = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
  listKbAskSessions: () => [],
  searchKbAskSessions: () => [],
  onKbAskChunk: () => () => {},
  onKbAskDone: () => () => {},
  onKbAskError: () => () => {},
  ...over
})

describe('知识库问答：服务商读不到那句旁边，得有一颗真能重发这一发的键', () => {
  it('失败脸有键 ⇒ 按下去真再发一发 ⇒ 到货后那句撤、下拉里回到那家服务商', async () => {
    let fail = true
    stubPocketai(kbStubs({ listProviders: () => (fail ? FAIL('PROV:通道炸了') : [PROVIDER]) }))
    mountWithProviders(<KbAskPanel kb={KB} />)
    await waitFor(() => expect(callsOf('listProviders')).toBe(1))
    await settle()
    expect(alerts()).toEqual([NAMED(L('common.providersList'), 'PROV:通道炸了')])
    const key = screen.getByTestId('kbask-providers-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listProviders')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('kbask-providers-read-retry')).toBeNull()
    expect(document.body.textContent).toContain('PROBE-PROVIDER')
  })
})

// ───────── ④ 浮窗：两份清单各失败一次 ⇒ 两句配两颗键，各点各的通道 ─────────
const popupStubs = (over: Record<string, (...a: unknown[]) => unknown> = {}): Record<string, any> => ({
  listProviders: () => [{ ...PROVIDER, models: [] }],
  listAssistants: () => [{ id: 'a1', name: '通用问答', isBuiltin: true }],
  getPopupPayload: () => null,
  onPopupPayload: () => () => {},
  fetchModels: () => ['m1'],
  onChatChunk: () => () => {},
  onChatDone: () => () => {},
  onChatError: () => () => {},
  hidePopup: () => ({ ok: true }),
  ...over
})

describe('浮窗：服务商与助手两张脸各配一颗键，各点各的那一发', () => {
  it('两发都挂 ⇒ 两颗键都在（且都在 alert 盒子外）⇒ 各按一次只多发自己那一条通道', async () => {
    const provFail = { v: true }
    const asstFail = { v: true }
    stubPocketai(popupStubs({
      listProviders: () => (provFail.v ? FAIL('PROV:通道炸了') : [{ ...PROVIDER, models: [] }]),
      listAssistants: () => (asstFail.v ? FAIL('ASST:通道炸了') : [{ id: 'a1', name: '通用问答', isBuiltin: true }])
    }))
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(callsOf('listProviders')).toBe(1))
    await settle()
    expect(alerts()).toEqual([
      NAMED(L('common.providersList'), 'PROV:通道炸了'),
      NAMED(L('common.assistantsList'), 'ASST:通道炸了')
    ])
    const pk = screen.getByTestId('popup-providers-read-retry')
    expect(pk.textContent).toBe(RETRY)
    const ak = screen.getByTestId('popup-assistants-read-retry')
    expect(ak.textContent).toBe(RETRY)
    expect(alerts().some((a) => a.includes(RETRY))).toBe(false)

    provFail.v = false
    fireEvent.click(pk)
    await waitFor(() => expect(callsOf('listProviders')).toBe(2))
    expect(callsOf('listAssistants')).toBe(1)
    await settle()
    await waitFor(() => expect(alerts()).toEqual([NAMED(L('common.assistantsList'), 'ASST:通道炸了')]))
    expect(screen.queryByTestId('popup-providers-read-retry')).toBeNull()
    // 那句助手读不到还在 ⇒ 它那颗键也还在（两句互不顶替）
    expect(screen.getByTestId('popup-assistants-read-retry')).toBeTruthy()

    asstFail.v = false
    fireEvent.click(ak)
    await waitFor(() => expect(callsOf('listAssistants')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('popup-assistants-read-retry')).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 两颗键都不在（键不是一张常驻的脸）', async () => {
    stubPocketai(popupStubs())
    mountWithProviders(<PopupApp />)
    await waitFor(() => expect(callsOf('listAssistants')).toBe(1))
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('popup-providers-read-retry')).toBeNull()
    expect(screen.queryByTestId('popup-assistants-read-retry')).toBeNull()
  })
})

// ───────── ⑤ 翻译页：服务商那一发 ─────────
const translateStubs = (over: Record<string, any> = {}): Record<string, any> => ({
  listProviders: () => [PROVIDER],
  listTranslations: () => [],
  listGlossary: () => [],
  onTranslateChunk: () => () => {},
  translate: () => new Promise(() => {}),
  abortTranslate: () => ({ ok: true }),
  ...over
})

describe('翻译页：服务商读不到 ⇒ 下拉那句「没有可用的服务商」让位，键按下去真再发一发', () => {
  it('失败脸有键 ⇒ 按下去真多发一发 ⇒ 到货后那句撤、下拉里回到那家服务商', async () => {
    let fail = true
    stubPocketai(translateStubs({ listProviders: () => (fail ? FAIL('PROV:通道炸了') : [PROVIDER]) }))
    mountWithProviders(<TranslateModule />)
    await waitFor(() => expect(callsOf('listProviders')).toBe(1))
    await settle()
    expect(alerts()).toEqual([NAMED(L('common.providersList'), 'PROV:通道炸了')])
    const key = screen.getByTestId('translate-providers-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listProviders')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('translate-providers-read-retry')).toBeNull()
    expect(document.body.textContent).toContain('PROBE-PROVIDER')
  })
})

// ───────── ⑥ 首启向导：硬件画像与模型推荐那两发 ─────────
const HW = {
  cpu: { model: 'PROBE-CPU', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const REC = {
  tier: 'mainstream', summary: 'nv_mainstream', summaryParams: { gpu: 'PROBE-GPU', vram: '8' },
  localPicks: [], onlineHint: 'default', ollamaRunning: false, installedModels: [], warnings: []
}

const wizardStubs = (over: Record<string, any> = {}): Record<string, any> => ({
  getHardwareInfo: () => ({ ok: true, data: HW }),
  getEncryptionStatus: () => ({
    mode: 'none', unlocked: true, dbEncrypted: false, fieldEncrypted: true,
    masterPasswordVerified: false, kdfN: null, kdfAtCurrentTier: false
  }),
  recommendModels: () => ({ ok: true, data: REC }),
  listProviders: () => [],
  listAssistants: () => [],
  listSkills: () => [],
  getOllamaStatus: () => ({ ok: true, installed: false, running: false, models: [], version: '' }),
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  onOllamaPullEvent: () => () => {},
  onOllamaInstallEvent: () => () => {},
  ...over
})

describe('首启向导欢迎页：硬件与推荐那两发各配一颗键（同一份 JSX 挂两个槽位⇒这一屏只两颗）', () => {
  it('两发都读不到 ⇒ 两句两颗键 ⇒ 各按一次只多发自己那一条通道，到货后各自收回自己那句', async () => {
    const hwFail = { v: true }
    const recFail = { v: true }
    stubPocketai(wizardStubs({
      getHardwareInfo: () => (hwFail.v ? FAIL('HW:探测炸了') : { ok: true, data: HW }),
      recommendModels: () => (recFail.v ? FAIL('REC:探测炸了') : { ok: true, data: REC })
    }))
    mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
    await waitFor(() => expect(callsOf('getHardwareInfo')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('HW:探测炸了'), FAILED('REC:探测炸了')])
    const hk = screen.getByTestId('wizard-hardware-read-retry')
    expect(hk.textContent).toBe(RETRY)
    const rk = screen.getByTestId('wizard-rec-read-retry')
    expect(rk.textContent).toBe(RETRY)
    expect(alerts().some((a) => a.includes(RETRY))).toBe(false)

    hwFail.v = false
    fireEvent.click(hk)
    await waitFor(() => expect(callsOf('getHardwareInfo')).toBe(2))
    expect(callsOf('recommendModels'), '按硬件那颗不该顺带重发推荐').toBe(1)
    await settle()
    await waitFor(() => expect(alerts()).toEqual([FAILED('REC:探测炸了')]))
    expect(screen.queryByTestId('wizard-hardware-read-retry')).toBeNull()
    expect(document.body.textContent, '硬件本体那行回来了').toContain('PROBE-CPU × 8')
    expect(screen.getByTestId('wizard-rec-read-retry')).toBeTruthy()

    recFail.v = false
    fireEvent.click(rk)
    await waitFor(() => expect(callsOf('recommendModels')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('wizard-rec-read-retry')).toBeNull()
  })

  it('反向对照：两发都读到 ⇒ 两颗键都不在', async () => {
    stubPocketai(wizardStubs())
    mountWithProviders(<FirstRunWizard variant="full" onClose={() => {}} />)
    await waitFor(() => expect(callsOf('recommendModels')).toBe(1))
    await settle()
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('wizard-hardware-read-retry')).toBeNull()
    expect(screen.queryByTestId('wizard-rec-read-retry')).toBeNull()
  })
})

// ───────── ⑦ 知识库·分块预览弹窗：那一发的写者在别的文件里吗？不写——它就在同一个非导出组件里，抽完才有键 ─────────
const KB_DOC = {
  id: 'd1', kbId: 'kbA', source: 'd1.md', sourceType: 'txt', title: '文档 d1',
  chunkCount: 1, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1
} as unknown as KbDocument

describe('知识库·分块预览：那句「读不到」旁边的键按下去真再发一发 listKbChunks', () => {
  it('打开那一格的瞬间读到 0 条、随后点那颗键读到一条 ⇒ 空态那句与那句原因各自让位', async () => {
    let fail = true
    stubPocketai({
      listKbDocuments: () => [KB_DOC],
      listKbChunks: () => (fail ? FAIL('CHUNK:索引在重建') : [
        { id: 'c1', docId: 'd1', kbId: 'kbA', sequence: 1, content: 'PROBE-分块', createdAt: 1 }
      ]),
      setKbDocEnabled: () => ({ ok: true }),
      reindexKbDocs: () => ({ enqueued: 0 }),
      addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
      checkKbUpdates: () => ({ checked: 1, issues: [] }),
      listProviders: () => [],
      listKbAskSessions: () => [],
      getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
      onKbAskChunk: () => () => {},
      onKbAskDone: () => () => {},
      onKbAskError: () => () => {},
      reportPerf: () => undefined
    })
    mountWithProviders(<KbDetail kb={{ id: 'kbA', name: '库甲' } as unknown as KnowledgeBase} onChanged={() => {}} />)
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    const opener = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === L('kb.chunks')
    )
    expect(opener, '行内那颗「分块」键在场').toBeTruthy()
    fireEvent.click(opener!)
    await waitFor(() => expect(callsOf('listKbChunks')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('CHUNK:索引在重建')])
    const key = screen.getByTestId('kb-chunks-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)
    expect(screen.queryByText(L('kb.noChunks')), '读不到不许演成"这个文档没有分块"').toBeNull()

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('listKbChunks')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('kb-chunks-read-retry')).toBeNull()
    expect(screen.getByText('PROBE-分块')).toBeTruthy()
  })
})
