// KB 升级阶段 1：详情页统一重建提示条——配置变更提示、一键重建、源文件变更入口
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbDocument, KbReindexNotice, KnowledgeBase } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const fill = (tpl: string, p: Record<string, string | number>): string =>
  Object.entries(p).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)), tpl)

const kb = (): KnowledgeBase =>
  ({
    id: 'kbA', name: '库甲', description: '', embeddingProviderId: 'p1', embeddingModel: 'm1',
    embeddingDim: 3, chunkSize: 800, chunkOverlap: 200, topK: 20, topN: 5, minScore: 0,
    rerankProviderId: null, rerankModel: null, hydeProviderId: null, hydeModel: null,
    multiQueryProviderId: null, multiQueryModel: null, ocrProviderId: null, ocrModel: null,
    documentCount: 1, chunkCount: 2, createdAt: 0
  }) as unknown as KnowledgeBase

const doc = (over: Partial<KbDocument> = {}): KbDocument =>
  ({
    id: 'd1', kbId: 'kbA', source: 'd1.md', sourceType: 'txt', title: '文档 d1',
    chunkCount: 2, status: 'ready', error: null, contentHash: null, enabled: true, createdAt: 1, ...over
  }) as unknown as KbDocument

const notice = (over: Partial<KbReindexNotice> = {}): KbReindexNotice => ({
  kbId: 'kbA', docCount: 4, embeddingChanged: true, chunkingChanged: false, ...over
})

const reindexKbDocs = vi.fn()
const checkKbUpdates = vi.fn()
const reindexKbDocument = vi.fn()
const deleteKbDocument = vi.fn()

beforeEach(() => {
  reindexKbDocs.mockReset().mockResolvedValue({ enqueued: 1 })
  checkKbUpdates.mockReset().mockResolvedValue({ checked: 0, issues: [] })
  reindexKbDocument.mockReset().mockResolvedValue({ ok: true })
  deleteKbDocument.mockReset().mockResolvedValue({ ok: true })
  stubPocketai({
    listKbDocuments: () => [doc()],
    listKbChunks: () => [],
    setKbDocEnabled: () => ({ ok: true }),
    reindexKbDocs,
    checkKbUpdates,
    reindexKbDocument,
    deleteKbDocument,
    addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    listProviders: () => [],
    listKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    reportPerf: () => undefined,
    setAppLanguage: () => Promise.resolve()
  })
})

describe('配置变更提示条', () => {
  it('有提示 ⇒ 展示受影响文档数，并给出「重建全部 / 稍后处理」', async () => {
    mountWithProviders(
      <KbDetail kb={kb()} onChanged={() => {}} reindexNotice={notice()} onReindexNoticeChange={() => {}} />
    )

    await waitFor(() => expect(screen.getByTestId('kb-reindex-notice')).toBeTruthy())
    expect(screen.getByText(fill(L('kb.reindexNotice'), { n: 4 }))).toBeTruthy()
    expect(screen.getByTestId('kb-reindex-all')).toBeTruthy()
    expect(screen.getByTestId('kb-reindex-dismiss')).toBeTruthy()
  })

  it('切库不串台：提示属于别的库 ⇒ 当前详情页不显示', async () => {
    mountWithProviders(
      <KbDetail
        kb={kb()}
        onChanged={() => {}}
        reindexNotice={notice({ kbId: 'kbOther' })}
        onReindexNoticeChange={() => {}}
      />
    )
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
    expect(screen.queryByTestId('kb-reindex-notice')).toBeNull()
  })

  it('点「重建全部」⇒ 一次批量入队当前库全部文档，成功后清提示', async () => {
    const onNoticeChange = vi.fn()
    mountWithProviders(
      <KbDetail kb={kb()} onChanged={() => {}} reindexNotice={notice()} onReindexNoticeChange={onNoticeChange} />
    )
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('kb-reindex-all'))
    await waitFor(() => {
      expect(reindexKbDocs).toHaveBeenCalledWith(['d1'])
      expect(onNoticeChange).toHaveBeenCalledWith(null)
    })
  })

  it('点「稍后处理」⇒ 清提示但不发重建', async () => {
    const onNoticeChange = vi.fn()
    mountWithProviders(
      <KbDetail kb={kb()} onChanged={() => {}} reindexNotice={notice()} onReindexNoticeChange={onNoticeChange} />
    )
    await waitFor(() => expect(screen.getByTestId('kb-reindex-notice')).toBeTruthy())

    fireEvent.click(screen.getByTestId('kb-reindex-dismiss'))
    expect(onNoticeChange).toHaveBeenCalledWith(null)
    expect(reindexKbDocs).not.toHaveBeenCalled()
  })
})

describe('源文件变更提示条', () => {
  it('检测到变更/丢失 ⇒ 提示条给出数量与「处理源文件变更」入口，处理后清除', async () => {
    checkKbUpdates.mockResolvedValue({
      checked: 2,
      issues: [
        { docId: 'd1', title: '文档 d1', source: 'd1.md', kind: 'changed' },
        { docId: 'd2', title: '文档 d2', source: 'd2.md', kind: 'missing' }
      ]
    })
    mountWithProviders(<KbDetail kb={kb()} onChanged={() => {}} />)
    await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())

    fireEvent.click(screen.getByText(L('kb.checkUpdates')))
    await waitFor(() => expect(screen.getByTestId('kb-sync-notice')).toBeTruthy())
    expect(screen.getByText(fill(L('kb.syncIssuesNotice'), { n: 1, m: 1 }))).toBeTruthy()
    expect(screen.getByTestId('kb-sync-handle')).toBeTruthy()

    fireEvent.click(screen.getByText(L('common.confirm')))
    await waitFor(() => expect(screen.queryByTestId('kb-sync-notice')).toBeNull())
  })
})
