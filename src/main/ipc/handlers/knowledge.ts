// 知识库 IPC：库管理 / 文档摄取 / 分块预览 / 检索测试（含免费版数量门控）
import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import type { KnowledgeBase } from '../../../shared/types'
import { kbRepo } from '../../db/repositories/kb.repo'
import { kbDocRepo } from '../../db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../../db/repositories/kb-chunk.repo'
import { ingestionService } from '../../knowledge/ingestion'
import { ragService } from '../../knowledge/rag'
import { detectSourceType } from '../../knowledge/parsers'
import { assertCanCreateKb } from '../../license/license'

export function registerKnowledgeHandlers(): void {
  ipcMain.handle(IPC.KB_LIST, () => kbRepo.list())
  ipcMain.handle(IPC.KB_GET, (_e, id: string) => kbRepo.get(id))
  ipcMain.handle(IPC.KB_SAVE, (_e, record: Partial<KnowledgeBase> & { name: string }) => {
    // License 门控：免费版限制知识库数量（新建场景）
    if (!record.id || !kbRepo.get(record.id)) {
      assertCanCreateKb(kbRepo.list().length)
    }
    return kbRepo.save(record)
  })
  ipcMain.handle(IPC.KB_DELETE, (_e, id: string) => {
    ingestionService.deleteKb(id)
    return { ok: true }
  })

  // ---------- 知识库文档 ----------
  ipcMain.handle(IPC.KB_DOC_LIST, (_e, kbId: string) => kbDocRepo.list(kbId))

  ipcMain.handle(IPC.KB_DOC_ADD_FILE, async (e, kbId: string) => {
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
    // 解析入库（顺序执行，避免压垮 Embedding API）
    await ingestionService.ingestDocuments(
      kbId,
      docs.map((d) => d.id)
    )
    return kbDocRepo.list(kbId)
  })

  ipcMain.handle(IPC.KB_DOC_ADD_URL, async (_e, kbId: string, url: string, title?: string) => {
    const doc = kbDocRepo.insert({ kbId, source: url, sourceType: 'url', title: title || url })
    await ingestionService.ingestDocument(kbId, doc.id)
    return kbDocRepo.get(doc.id)
  })

  ipcMain.handle(
    IPC.KB_DOC_ADD_TEXT,
    async (_e, kbId: string, text: string, title: string) => {
      // 纯文本直接入库：跳过解析，直接分块+向量化
      const doc = kbDocRepo.insert({ kbId, source: title, sourceType: 'txt', title })
      await ingestionService.ingestText(kbId, doc.id, text, title)
      return kbDocRepo.get(doc.id)
    }
  )

  ipcMain.handle(IPC.KB_DOC_DELETE, (_e, docId: string) => {
    kbDocRepo.delete(docId)
    return { ok: true }
  })

  ipcMain.handle(IPC.KB_DOC_REINDEX, async (_e, kbId: string, docId: string) => {
    await ingestionService.ingestDocument(kbId, docId)
    return kbDocRepo.get(docId)
  })

  // ---------- 知识库分块 ----------
  ipcMain.handle(IPC.KB_CHUNK_LIST, (_e, docId: string) => kbChunkRepo.listByDoc(docId))

  // ---------- 知识库检索测试 ----------
  ipcMain.handle(IPC.KB_RETRIEVE, async (_e, kbIds: string[], query: string) =>
    ragService.retrieve(kbIds, query)
  )
}
