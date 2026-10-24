// §282：来源跳转「落点侧」真挂载（补 B61/B62 那两条 🔶 里 CI 没碰的那半）。
// 入口侧（Agent 气泡产 pending + 广播 + 切模块）在 `renderer-agent-source-jump.test.tsx` 已钉死；
// 这里接的是另一头——KnowledgeModule 消费 pending 后把 jumpFocus 交给 KbDetail，
// KbDetail 要：① 命中已加载到的文档才打开分块预览（文档不存在则悬空不消费）；
// ② ChunkPreview 滚动到目标分块并高亮闪烁；③ 消费后回调清 pending。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KnowledgeBase, KbDocument, KbChunk } from '../src/shared/types'

const kb = (over: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
  id: 'kbA', name: '库甲', description: '', embeddingProviderId: 'p1', embeddingModel: 'm1',
  embeddingDim: 3, chunkSize: 800, chunkOverlap: 200, topK: 20, topN: 5, minScore: 0,
  rerankProviderId: null, rerankModel: null, hydeProviderId: null, hydeModel: null,
  multiQueryProviderId: null, multiQueryModel: null, ocrProviderId: null, ocrModel: null,
  documentCount: 1, chunkCount: 3, createdAt: 0, ...over
})

const doc = (id: string, over: Partial<KbDocument> = {}): KbDocument => ({
  id, kbId: 'kbA', source: `${id}.md`, sourceType: 'txt', title: `文档 ${id}`,
  chunkCount: 3, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1, ...over
})

const chunk = (seq: number): KbChunk => ({
  id: `c${seq}`, docId: 'd1', kbId: 'kbA', sequence: seq, content: `分块正文 ${seq}`, createdAt: 1
})

const DOCS = [doc('d1'), doc('d2')]
const CHUNKS = [chunk(0), chunk(1), chunk(2)]

const listKbDocuments = vi.fn()
const listKbChunks = vi.fn()
let scrollSpy: ReturnType<typeof vi.fn>

function mountDetail(jump: { docId: string; seq: number } | null | undefined, onHandled?: () => void): void {
  mountWithProviders(
    <KbDetail kb={kb()} onChanged={() => {}} jumpFocus={jump} onJumpHandled={onHandled} />
  )
}

beforeEach(() => {
  listKbDocuments.mockReset().mockResolvedValue(DOCS)
  listKbChunks.mockReset().mockResolvedValue(CHUNKS)
  // jsdom 没有 scrollIntoView——effect 直接调用它会抛 ⇒ 装个 spy 既防崩又能断"真的滚了"
  scrollSpy = vi.fn()
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy
  stubPocketai({
    listKbDocuments,
    listKbChunks,
    deleteKbDocument: vi.fn(async () => ({ ok: true })),
    setKbDocEnabled: vi.fn(async () => ({ ok: true })),
    reindexKbDocs: vi.fn(async () => ({ enqueued: 0 })),
    reindexKbDocument: vi.fn(async () => ({ ok: true })),
    addKbFiles: vi.fn(async () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 })),
    listProviders: vi.fn(async () => []),
    listKbAskSessions: vi.fn(async () => []),
    getKbAskRetention: vi.fn(async () => ({ keepCount: 0, keepDays: 0 })),
    onKbAskChunk: vi.fn(() => () => {}),
    onKbAskDone: vi.fn(() => () => {}),
    onKbAskError: vi.fn(() => () => {}),
    reportPerf: vi.fn(async () => undefined)
  })
})
afterEach(() => {
  // 不还原也行（每个用例 beforeEach 重装），但留着免得污染别的文件
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
})

const highlightClass = 'ring-1'

describe('KbDetail jumpFocus 落点', () => {
  it('命中已加载到的文档 ⇒ 自动打开分块预览（标题带 doc 名），无需手点', async () => {
    mountDetail({ docId: 'd1', seq: 2 })
    await waitFor(() => expect(screen.getByText(zh['kb.chunkPreview'].replace('{title}', '文档 d1'))).toBeTruthy())
  })

  it('目标分块被滚动定位并高亮，别的分块不高亮', async () => {
    mountDetail({ docId: 'd1', seq: 1 })
    await waitFor(() => expect(screen.getByText('分块正文 1')).toBeTruthy())
    const target = document.getElementById('kb-chunk-1')!
    const other = document.getElementById('kb-chunk-2')!
    expect(target.className).toContain(highlightClass)
    expect(other.className).not.toContain(highlightClass)
    expect(scrollSpy).toHaveBeenCalled()
  })

  it('反向对照：没有 jumpFocus ⇒ 不打开预览（正常进详情页不该弹分块窗）', async () => {
    mountDetail(null)
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    expect(screen.queryByText(zh['kb.chunkPreview'].replace('{title}', '文档 d1'))).toBeNull()
    expect(listKbChunks).not.toHaveBeenCalled()
  })

  it('悬空对照：jumpFocus 指向已删除/不属于本库的文档 ⇒ 不消费、不开预览、不回清 pending', async () => {
    const onHandled = vi.fn()
    mountDetail({ docId: 'gone', seq: 0 }, onHandled)
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    expect(screen.queryByText(/分块预览/)).toBeNull()
    expect(onHandled).not.toHaveBeenCalled()
    expect(listKbChunks).not.toHaveBeenCalled()
  })

  it('消费后回调清 pending（同一次跳转不重复弹）', async () => {
    const onHandled = vi.fn()
    mountDetail({ docId: 'd2', seq: 0 }, onHandled)
    await waitFor(() => expect(screen.getByText(zh['kb.chunkPreview'].replace('{title}', '文档 d2'))).toBeTruthy())
    expect(onHandled).toHaveBeenCalledTimes(1)
  })

  it('seq=0 是真序号 ⇒ 高亮落在那一条上（真值判断 `if (!seq)` 会把它吃掉）', async () => {
    mountDetail({ docId: 'd1', seq: 0 })
    await waitFor(() => expect(screen.getByText('分块正文 0')).toBeTruthy())
    expect(document.getElementById('kb-chunk-0')!.className).toContain(highlightClass)
  })

  it('关窗（点遮罩）后回到文档列表，不再留着预览', async () => {
    mountDetail({ docId: 'd1', seq: 2 })
    await waitFor(() => expect(screen.getByText(zh['kb.chunkPreview'].replace('{title}', '文档 d1'))).toBeTruthy())
    fireEvent.click(screen.getByText(zh['common.close']))
    await waitFor(() => expect(screen.queryByText(zh['kb.chunkPreview'].replace('{title}', '文档 d1'))).toBeNull())
  })
})
