// §332：知识库详情那一屏的"切库族"——三处不带 key 的组件 ＋ 库表单那颗没锁的「保存」 ＋ 检索测试的 Enter 路由
//
// 紧邻的姊妹屏（`KbEvalPanel`、`KbAskPanel`）早就带 `key={kb.id}` 并写明理由：`KbDetail` 本身不带 key，
// 切库是**同一个实例**，所以子组件自己的 state 会跨库存活。这一份用例钉的就是那三张脸：
//  · `KbForm`（库 A 点「设置」→ 左栏点库 B → 保存）：字段初值只在 mount 时取，而 payload 里的 id 是**当前**那份
//    ⇒ A 的嵌入模型与分块参数落进 B（A 没动、B 被覆盖，且 embeddingDim 保旧值 ⇒ B 的旧向量再也召不回）。
//  · `AddSourceDialog`（库 A 点「添加 URL」→ 粘好 → 切库 B → 确定）：文档进错库。
//  · `RetrievalTest`（库 A 检索 → 切库 B）：屏上仍摆 A 的命中与诊断，而标题与 topN 已是 B 的。
//  · `KbForm` 的「保存」没防重入 ⇒ 新建库连点两下开两本（`kb.repo.ts:90` 各拿一个 randomUUID）。
//  · `RetrievalTest` 的输入框改前不设防 ⇒ Enter 绕过那颗 `disabled={loading}` 的按钮；输入法确认候选词那次
//    Enter 也照样发一发（同屏 `KbAskPanel.tsx:834` 早已判 `isComposing`）。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { HookProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

const kb = (id: string, over: Partial<KnowledgeBase> = {}): KnowledgeBase =>
  ({
    id,
    name: `库 ${id}`,
    description: '',
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    embeddingDim: 3,
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 20,
    topN: 5,
    minScore: 0,
    rerankProviderId: null,
    rerankModel: null,
    hydeProviderId: null,
    hydeModel: null,
    multiQueryProviderId: null,
    multiQueryModel: null,
    ocrProviderId: null,
    ocrModel: null,
    documentCount: 1,
    chunkCount: 0,
    createdAt: 0,
    ...over
  }) as unknown as KnowledgeBase

const searchBox = (): HTMLElement => screen.getByPlaceholderText(L('kb.searchPh'))
const urlBox = (): HTMLElement => screen.getByPlaceholderText('https://example.com/article')
const nameBox = (): HTMLElement => screen.getByPlaceholderText(L('kb.namePh'))

let inFlight: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(inFlight[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = inFlight[key] ?? []
  inFlight[key] = []
  queue.forEach((resolve) => resolve(v))
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  inFlight = {}
  stubPocketai({
    listKbDocuments: () => [],
    listKbChunks: () => [],
    listProviders: () => [],
    listKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 20, keepDays: 30 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    deleteKbDocument: () => ({ ok: true }),
    setKbDocEnabled: () => ({ ok: true }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    reindexKbDocument: () => ({ ok: true }),
    addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    addKbUrl: (kbId: string) => pend(`url:${kbId}`),
    saveKnowledgeBase: () => pend('save'),
    retrieveKbDebug: (ids: string[]) => pend(`dbg:${ids.join(',')}`),
    reportPerf: () => undefined,
    setAppLanguage: () => Promise.resolve()
  })
})

const tree = (id: string): React.ReactElement => (
  <HookProviders><KbDetail kb={kb(id)} onChanged={() => {}} /></HookProviders>
)

const mountDetail = (id: string): ReturnType<typeof render> => render(tree(id))

describe('332② 库表单：切库后用新库的值重挂，保存写的是这一本', () => {
  it('库 A 点「设置」→ 切到库 B ⇒ 名称字段是 B 的（改前是 A 的，而 payload 里的 id 已是 B）', async () => {
    const view = mountDetail('kbA')
    fireEvent.click(screen.getByText(L('kb.settings')))
    await waitFor(() => expect(nameBox()).toBeTruthy())
    fireEvent.change(nameBox(), { target: { value: '我在 A 上改了一半的名字' } })

    view.rerender(tree('kbB'))
    await settle()

    expect((nameBox() as HTMLInputElement).value, '表单必须跟着换成 B 的那份').toBe('库 kbB')
  })

  it('新建库连点两下「保存」⇒ saveKnowledgeBase 只发一发，且第二下点在 disabled 上', async () => {
    mountDetail('kbNew')
    fireEvent.click(screen.getByText(L('kb.settings')))
    await waitFor(() => expect(nameBox()).toBeTruthy())
    fireEvent.change(nameBox(), { target: { value: '甲库' } })
    // 选内置那家 provider：此时模型字段是只读的常量（`BUILTIN_EMBED_MODEL`），两道必填校验自然过
    const select = document.querySelector('select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'builtin' } })

    const save = screen.getByText(L('common.save'))
    fireEvent.click(save)
    await waitFor(() => expect(inFlight.save?.length).toBe(1))
    fireEvent.click(save)
    expect(pocketaiCalls().filter((c) => c.fn === 'saveKnowledgeBase').length, '第二下不许再发一发').toBe(1)
    expect(save.closest('button')?.disabled, '在飞期间那颗键是 disabled').toBe(true)

    await answer('save', { id: 'kbNew', name: '甲库' })
    await settle()
    // 成功后表单交回父级（`onSaved` ⇒ 退出编辑态）；这一句同时证明锁不是一次性卡死的
    expect(screen.queryByPlaceholderText(L('kb.namePh')), '保存完成后应退出编辑态（锁不卡死）').toBeNull()
  })
})

describe('332③ 添加 URL 弹窗：切库要重挂，文档不许进错库', () => {
  it('库 A 粘好网址 → 切到库 B ⇒ 输入框回到空（改前留着 A 的网址而 kbId 已是 B，点确定就进 B）', async () => {
    const view = mountDetail('kbA')
    fireEvent.click(screen.getByText(L('kb.addUrl')))
    await waitFor(() => expect(urlBox()).toBeTruthy())
    fireEvent.change(urlBox(), { target: { value: 'https://example.com/甲' } })

    view.rerender(tree('kbB'))
    await settle()

    expect((urlBox() as HTMLInputElement).value, '弹窗随切库重挂＝不带旧网址过来').toBe('')
  })
})

describe('332④ 检索测试的 Enter 路由：在飞与输入法确认都不许多发一发', () => {
  it('在飞时输入框 disabled（Enter 那条路改前绕过那颗 disabled 的按钮 ⇒ 三发并发）', async () => {
    mountDetail('kbA')
    fireEvent.change(searchBox(), { target: { value: '甲查询' } })
    fireEvent.keyDown(searchBox(), { key: 'Enter' })
    await waitFor(() => expect(inFlight['dbg:kbA']?.length).toBe(1))
    // 第二下 Enter 落在 disabled 的输入框上 ⇒ 不该再打一发
    fireEvent.keyDown(searchBox(), { key: 'Enter' })
    await settle()
    expect(pocketaiCalls().filter((c) => c.fn === 'retrieveKbDebug').length, '在飞期间 Enter 不许绕过守卫').toBe(1)
    expect(searchBox()).toHaveProperty('disabled', true)

    await answer('dbg:kbA', { result: { chunks: [] }, diagnostics: null })
    await settle()
    expect(searchBox(), '跑完要解锁，否则这颗键再也搜不了').toHaveProperty('disabled', false)
  })

  it('输入法确认候选词的那次 Enter 不许发检索（`isComposing` 为真）', () => {
    mountDetail('kbA')
    fireEvent.change(searchBox(), { target: { value: '甲查询' } })
    fireEvent.keyDown(searchBox(), { key: 'Enter', isComposing: true })
    expect(pocketaiCalls().some((c) => c.fn === 'retrieveKbDebug'), '合成中的 Enter 不算一次提交').toBe(false)
  })
})
