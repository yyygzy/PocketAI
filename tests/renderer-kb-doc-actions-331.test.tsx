// §331（知识库详情那一屏的四张脸）：写操作失败不许演成功、跳过的文件要说出口
//
// 全部走真挂载（KbDetail 有现成夹具，抄 `renderer-kb-detail-batch.test.tsx`／`renderer-kb-jump-focus-282.test.tsx`）：
//  · K1 文档重命名／K2 编辑原文——safeHandle 的失败是 resolve 的 `{ok:false}`，改前两处完全不判：
//    失败照样报「已重命名／已保存」并关窗，而 K2 那一下还把 textarea 卸载 ⇒ 刚写的原文永久丢失。
//  · K4 增量同步那一趟是 N 发独立请求，改前逐条不判、末尾无条件报「已重索引 n 个、移除 m 个」⇒ 全失败报全成功。
//  · K5 导入文件夹的 `skippedCount`（类型不支持／图片未开 OCR／超过单文件大小上限）改前渲染层从不读。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { KbDetail } from '../src/renderer/src/modules/knowledge/KnowledgeModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { KbDocument, KnowledgeBase } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const fill = (tpl: string, p: Record<string, string | number>): string =>
  Object.entries(p).reduce((s, [k, v]) => s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)), tpl)
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())

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

const renameKbDocument = vi.fn()
const updateKbDocText = vi.fn()
const getKbDocText = vi.fn()
const checkKbUpdates = vi.fn()
const reindexKbDocument = vi.fn()
const deleteKbDocument = vi.fn()
const addKbFolder = vi.fn()
const fail = { ok: false as const, error: '文档已经不在了', ipcCode: 'KB_DOC_GONE' }

beforeEach(() => {
  renameKbDocument.mockReset().mockResolvedValue(doc({ title: '新标题' }))
  updateKbDocText.mockReset().mockResolvedValue(doc())
  getKbDocText.mockReset().mockResolvedValue({ title: '文档 d1', text: '原始正文' })
  checkKbUpdates.mockReset().mockResolvedValue({ checked: 2, issues: [] })
  reindexKbDocument.mockReset().mockResolvedValue({ ok: true })
  deleteKbDocument.mockReset().mockResolvedValue({ ok: true })
  addKbFolder.mockReset().mockResolvedValue({ docs: [doc()], skippedCount: 0, truncated: false, skippedSameSource: 0, skippedSameContent: 0 })
  stubPocketai({
    listKbDocuments: () => [doc()],
    listKbChunks: () => [],
    setKbDocEnabled: () => ({ ok: true }),
    reindexKbDocs: () => ({ enqueued: 0 }),
    addKbFiles: () => ({ docs: [], skippedSameSource: 0, skippedSameContent: 0 }),
    renameKbDocument,
    updateKbDocText,
    getKbDocText,
    checkKbUpdates,
    reindexKbDocument,
    deleteKbDocument,
    addKbFolder,
    listProviders: () => [],
    listKbAskSessions: () => [],
    getKbAskRetention: () => ({ keepCount: 0, keepDays: 0 }),
    onKbAskChunk: () => () => {},
    onKbAskDone: () => () => {},
    onKbAskError: () => () => {},
    reportPerf: () => undefined,
    setAppLanguage: () => Promise.resolve()
  })
  mountWithProviders(<KbDetail kb={kb()} onChanged={() => {}} />)
})

/** 打开某一行的弹窗并等它出来（行内那颗按钮的文本＝键值本身；列表是先异步拉回来的） */
const openRowDialog = async (label: string, titleKey: string): Promise<void> => {
  await waitFor(() => expect(screen.getByText('文档 d1')).toBeTruthy())
  fireEvent.click(screen.getByText(label))
  await waitFor(() => expect(screen.getByText(L(titleKey))).toBeTruthy())
}

describe('K1 文档重命名：失败不许演成功', () => {
  it('那一发回 {ok:false} ⇒ 说原因、弹窗不关、不报「已重命名」', async () => {
    renameKbDocument.mockResolvedValue(fail)
    await openRowDialog(L('kb.rename'), 'kb.renameTitle')
    fireEvent.click(screen.getByText(L('common.save')))

    await waitFor(() => expect(toasts().join('|')).not.toContain(L('kb.renameOk')))
    expect(screen.getByText(L('kb.renameTitle'))).toBeTruthy()
    expect(screen.getByText('文档已经不在了')).toBeTruthy()
  })

  it('正向对照：成功那趟照常报「已重命名」并关窗', async () => {
    await openRowDialog(L('kb.rename'), 'kb.renameTitle')
    fireEvent.click(screen.getByText(L('common.save')))

    await waitFor(() => expect(toasts().join('|')).toContain(L('kb.renameOk')))
    expect(screen.queryByText(L('kb.renameTitle'))).toBeNull()
  })
})

describe('K2 编辑原文：失败不许把刚写的原文一起带走', () => {
  it('那一发回 {ok:false} ⇒ textarea 还挂着、里面就是刚敲的那段', async () => {
    updateKbDocText.mockResolvedValue(fail)
    await openRowDialog(L('kb.editText'), 'kb.editTextTitle')
    const area = document.querySelector('textarea')!
    fireEvent.change(area, { target: { value: '改了一半的长文，不能丢' } })
    fireEvent.click(screen.getByText(L('common.save')))

    await waitFor(() => expect(toasts().join('|')).not.toContain(L('kb.editOk')))
    expect(screen.getByText(L('kb.editTextTitle'))).toBeTruthy()
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('改了一半的长文，不能丢')
  })

  it('正向对照：成功那趟报「已保存」并关窗', async () => {
    await openRowDialog(L('kb.editText'), 'kb.editTextTitle')
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '正常一段' } })
    fireEvent.click(screen.getByText(L('common.save')))

    await waitFor(() => expect(toasts().join('|')).toContain(L('kb.editOk')))
    expect(screen.queryByText(L('kb.editTextTitle'))).toBeNull()
  })
})

describe('K4 增量同步那一趟：N 发各自判、两笔账分开数', () => {
  const issues = [
    { docId: 'd1', kind: 'changed' },
    { docId: 'd2', kind: 'changed' },
    { docId: 'd3', kind: 'missing' }
  ]

  const runSync = async (): Promise<void> => {
    checkKbUpdates.mockResolvedValue({ checked: 3, issues })
    fireEvent.click(screen.getByText(L('kb.checkUpdates')))
    await waitFor(() => expect(screen.getByText(fill(L('kb.syncConfirm'), { n: 2, m: 1 }))).toBeTruthy())
    fireEvent.click(screen.getByText(L('common.confirm')))
  }

  it('三发全失败 ⇒ 走红的那句「一个都没处理成功」，绝不出现「已重索引 2 个、移除 1 个」', async () => {
    reindexKbDocument.mockResolvedValue(fail)
    deleteKbDocument.mockResolvedValue(fail)
    await runSync()

    await waitFor(() => expect(toasts().join('|')).toContain(fill(L('kb.syncAllFailed'), { n: 3 })))
    expect(toasts().join('|')).not.toContain(fill(L('kb.syncDone'), { n: 2, m: 1 }))
  })

  it('部分成功 ⇒ 成功数与失败数各说各的（不合成一个"看着像全成"的数）', async () => {
    reindexKbDocument.mockResolvedValue({ ok: true })
    deleteKbDocument.mockResolvedValue(fail)
    await runSync()

    // 两发 reindex 都成、一发 delete 失败 ⇒ ok=2、failed=1
    await waitFor(() => expect(toasts().join('|')).toContain(fill(L('kb.syncPartial'), { ok: 2, failed: 1 })))
  })

  it('正向对照：全成功那趟仍报旧的完成句，数字取真做成了几条（不是列表长度）', async () => {
    await runSync()

    await waitFor(() => expect(toasts().join('|')).toContain(fill(L('kb.syncDone'), { n: 2, m: 1 })))
  })
})

describe('K5 导入文件夹：被跳过的文件要报数', () => {
  it('skippedCount=7 ⇒ 那句「另有 7 个文件被跳过」上屏', async () => {
    addKbFolder.mockResolvedValue({
      docs: [doc()], skippedCount: 7, truncated: false, skippedSameSource: 0, skippedSameContent: 0
    })
    fireEvent.click(screen.getByText(L('kb.importFolder')))

    await waitFor(() => expect(toasts().join('|')).toContain(fill(L('kb.folderSkipped'), { n: 7 })))
  })

  it('反向对照：一个都没跳过时不许凭空冒出一句「被跳过 0 个」', async () => {
    fireEvent.click(screen.getByText(L('kb.importFolder')))
    await waitFor(() => expect(renameKbDocument).not.toHaveBeenCalled())

    expect(toasts().join('|')).not.toContain(fill(L('kb.folderSkipped'), { n: 0 }))
  })
})
