// 知识库 IPC：库管理 / 文档摄取 / 分块预览 / 检索测试（含免费版数量门控）
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import type { KnowledgeBase } from '../../../shared/types'
import { kbRepo } from '../../db/repositories/kb.repo'
import { kbDocRepo } from '../../db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../../db/repositories/kb-chunk.repo'
import { ingestionService } from '../../knowledge/ingestion'
import { indexQueue } from '../../knowledge/index-queue'
import { ragService } from '../../knowledge/rag'
import { detectSourceType } from '../../knowledge/parsers'
import { assertCanCreateKb } from '../../license/license'
import { safeHandle, argsSchema } from '../safe-handle'
import {
  kbSaveSchema,
  kbDocAddUrlArgsSchema,
  kbDocAddTextArgsSchema,
  kbRetrieveArgsSchema
} from '../../../shared/schemas/knowledge'
import { idSchema } from '../../../shared/schemas/providers'

export function registerKnowledgeHandlers(): void {
  safeHandle(IPC.KB_LIST, () => kbRepo.list())
  safeHandle(IPC.KB_GET, (_e, id: string) => kbRepo.get(id), argsSchema(idSchema))
  safeHandle(IPC.KB_SAVE, (_e, record: Partial<KnowledgeBase> & { name: string }) => {
    // License 门控：免费版限制知识库数量（新建场景）
    if (!record.id || !kbRepo.get(record.id)) {
      assertCanCreateKb(kbRepo.list().length)
    }
    return kbRepo.save(record)
  }, argsSchema(kbSaveSchema))
  safeHandle(IPC.KB_DELETE, (_e, id: string) => {
    ingestionService.deleteKb(id)
    return { ok: true }
  }, argsSchema(idSchema))

  // ---------- 知识库文档 ----------
  safeHandle(IPC.KB_DOC_LIST, (_e, kbId: string) => kbDocRepo.list(kbId), argsSchema(idSchema))

  safeHandle(IPC.KB_DOC_ADD_FILE, async (e, kbId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择知识库文档',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: ['pdf', 'docx', 'xlsx', 'xls', 'html', 'htm', 'txt', 'md', 'markdown', 'csv', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return []

    const docs = result.filePaths.map((p) => {
      const sourceType = detectSourceType(p)
      return kbDocRepo.insert({ kbId, source: p, sourceType, title: p })
    })
    // 后台异步入库（不阻塞 IPC），前端轮询文档状态
    for (const doc of docs) {
      indexQueue.enqueue({ kbId, docId: doc.id, kind: 'file' })
    }
    return docs
  }, argsSchema(idSchema))

  safeHandle(IPC.KB_DOC_ADD_URL, async (_e, kbId: string, url: string, title?: string) => {
    const doc = kbDocRepo.insert({ kbId, source: url, sourceType: 'url', title: title || url })
    indexQueue.enqueue({ kbId, docId: doc.id, kind: 'url' })
    return doc
  }, kbDocAddUrlArgsSchema)

  safeHandle(
    IPC.KB_DOC_ADD_TEXT,
    async (_e, kbId: string, text: string, title: string) => {
      const doc = kbDocRepo.insert({ kbId, source: title, sourceType: 'txt', title })
      indexQueue.enqueue({ kbId, docId: doc.id, kind: 'text', payload: { text, title } })
      return doc
    },
    kbDocAddTextArgsSchema
  )

  safeHandle(IPC.KB_DOC_DELETE, (_e, docId: string) => {
    kbDocRepo.delete(docId)
    return { ok: true }
  }, argsSchema(idSchema))

  safeHandle(IPC.KB_DOC_REINDEX, (_e, kbId: string, docId: string) => {
    // 重置状态为 pending，后台异步重建索引
    kbDocRepo.setStatus(docId, 'pending')
    indexQueue.enqueue({ kbId, docId, kind: 'reindex' })
    return kbDocRepo.get(docId)
  }, argsSchema(idSchema, idSchema))

  // ---------- 知识库分块 ----------
  safeHandle(IPC.KB_CHUNK_LIST, (_e, docId: string) => kbChunkRepo.listByDoc(docId), argsSchema(idSchema))

  // ---------- 知识库检索测试 ----------
  safeHandle(IPC.KB_RETRIEVE, async (_e, kbIds: string[], query: string) =>
    ragService.retrieve(kbIds, query),
  kbRetrieveArgsSchema)
}
