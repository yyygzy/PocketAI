// 知识库 IPC：库管理 / 文档摄取 / 分块预览 / 检索测试（含免费版数量门控）
import { z } from 'zod'
import fs from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { IPC } from '../../../shared/types'
import type { KnowledgeBase } from '../../../shared/types'
import { kbRepo } from '../../db/repositories/kb.repo'
import { kbDocRepo } from '../../db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../../db/repositories/kb-chunk.repo'
import { kbAskSessionRepo } from '../../db/repositories/kb-ask-session.repo'
import { ingestionService } from '../../knowledge/ingestion'
import { indexQueue } from '../../knowledge/index-queue'
import { ragService } from '../../knowledge/rag'
import { kbAskService } from '../../knowledge/ask-service'
import { getKbAskRetention, setKbAskRetention } from '../../knowledge/ask-retention-config'
import { checkKbFileUpdates } from '../../knowledge/sync-check'
import { scanFolderFiles } from '../../knowledge/folder-scan'
import { detectSourceType } from '../../knowledge/parsers'
import { assertCanCreateKb } from '../../license/license'
import { safeHandle, argsSchema } from '../safe-handle'
import {
  kbSaveSchema,
  kbDocAddUrlArgsSchema,
  kbDocAddTextArgsSchema,
  kbDocGetTextArgsSchema,
  kbDocUpdateTextArgsSchema,
  kbDocRenameArgsSchema,
  kbRetrieveArgsSchema
} from '../../../shared/schemas/knowledge'
import { idSchema } from '../../../shared/schemas/providers'
import { buildKbAskSessionMarkdown, safeFileName } from '../../../shared/export-markdown'
import type { KbAskSessionRecord } from '../../../shared/types'

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
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
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

  safeHandle(IPC.KB_DOC_ADD_FOLDER, async (e, kbId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择要导入的文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { docs: [], skippedCount: 0, truncated: false }
    }

    // 递归扫描：按扩展名过滤，跳过隐藏目录/node_modules/符号链接，单文件 50MB、单次 500 个上限
    // 图片仅在 KB 配置了 OCR 视觉模型时收，否则扫描阶段直接跳过
    const kb = kbRepo.get(kbId)
    const includeImages = !!(kb?.ocrProviderId && kb?.ocrModel)
    const scan = scanFolderFiles(result.filePaths[0]!, includeImages)
    const docs = scan.files.map((p) => {
      const sourceType = detectSourceType(p)
      return kbDocRepo.insert({ kbId, source: p, sourceType, title: p })
    })
    // 后台异步入库（不阻塞 IPC），前端轮询文档状态
    for (const doc of docs) {
      indexQueue.enqueue({ kbId, docId: doc.id, kind: 'file' })
    }
    return { docs, skippedCount: scan.skippedCount, truncated: scan.truncated }
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

  // ---------- 文档重命名 / txt 文档原文编辑 ----------
  safeHandle(IPC.KB_DOC_GET_TEXT, (_e, docId: string) => {
    const doc = kbDocRepo.get(docId)
    if (!doc || doc.sourceType !== 'txt') return null
    const text = kbDocRepo.getRawText(docId)
    if (!text) return null // v42 前录入的文本无原文，UI 给删除重加引导
    return { title: doc.title, text }
  }, kbDocGetTextArgsSchema)

  safeHandle(
    IPC.KB_DOC_UPDATE_TEXT,
    (_e, docId: string, title: string, text: string) => {
      const doc = kbDocRepo.get(docId)
      if (!doc) throw new Error('文档不存在')
      if (doc.sourceType !== 'txt' || !kbDocRepo.getRawText(docId)) {
        // 非 txt 不应走到（UI 无入口）；v42 前存量无原文无法编辑
        throw new Error('该文本录入于旧版本，原文未保存，无法编辑，请删除后重新添加')
      }
      kbDocRepo.rename(docId, title)
      kbDocRepo.setRawText(docId, text)
      kbDocRepo.setStatus(docId, 'pending')
      indexQueue.enqueue({ kbId: doc.kbId, docId, kind: 'text', payload: { text, title } })
      return kbDocRepo.get(docId)
    },
    kbDocUpdateTextArgsSchema
  )

  safeHandle(
    IPC.KB_DOC_RENAME,
    (_e, docId: string, title: string) => {
      const doc = kbDocRepo.rename(docId, title)
      if (!doc) throw new Error('文档不存在')
      return doc
    },
    kbDocRenameArgsSchema
  )

  // ---------- 知识库分块 ----------
  safeHandle(IPC.KB_CHUNK_LIST, (_e, docId: string) => kbChunkRepo.listByDoc(docId), argsSchema(idSchema))

  // ---------- 知识库检索测试 ----------
  safeHandle(IPC.KB_RETRIEVE, async (_e, kbIds: string[], query: string) =>
    ragService.retrieve(kbIds, query),
  kbRetrieveArgsSchema)
  // 检索诊断版：附带来源路/查询变体/命中数（检索测试面板用）
  safeHandle(IPC.KB_RETRIEVE_DEBUG, async (_e, kbIds: string[], query: string) =>
    ragService.retrieveWithDiagnostics(kbIds, query),
  kbRetrieveArgsSchema)

  // ---------- KB 问答模式（选库即聊，流式生成） ----------
  const kbAskArgsSchema = z.object({
    kbIds: z.array(idSchema).min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    question: z.string().min(1).max(100_000),
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).max(50)
  })
  safeHandle(IPC.KB_ASK, (e, args: {
    kbIds: string[]
    providerId: string
    model: string
    question: string
    history: { role: 'user' | 'assistant'; content: string }[]
  }) => kbAskService.ask(e.sender, args), argsSchema(kbAskArgsSchema))
  safeHandle(IPC.KB_ASK_ABORT, (_e, requestId: string) => {
    kbAskService.abort(requestId)
    return { ok: true }
  }, argsSchema(z.string().min(1)))

  // ---------- KB 问答留痕（会话落库，渲染端全量 upsert 单写路径） ----------
  const kbAskSessionSaveSchema = z.object({
    id: z.string().min(1),
    kbId: idSchema,
    title: z.string().max(200),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
          sources: z
            .array(
              z.object({
                chunkId: z.string(),
                docId: z.string(),
                docTitle: z.string(),
                content: z.string(),
                kbId: z.string().optional(),
                seq: z.number().optional()
              })
            )
            .optional()
        })
      )
      .max(200),
    providerId: z.string(),
    model: z.string(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive()
  })
  safeHandle(IPC.KB_ASK_SESSION_SAVE, (_e, record: KbAskSessionRecord) => {
    kbAskSessionRepo.upsert(record)
    // 自动清理：用户显式配置保留策略后，保存新会话时顺手 prune 该库
    const retention = getKbAskRetention()
    if (retention.keepCount > 0 || retention.keepDays > 0) {
      kbAskSessionRepo.prune(record.kbId, retention)
    }
    return { ok: true }
  }, argsSchema(kbAskSessionSaveSchema))
  safeHandle(IPC.KB_ASK_SESSION_LIST, (_e, kbId: string) => kbAskSessionRepo.listByKb(kbId), argsSchema(idSchema))
  safeHandle(IPC.KB_ASK_SESSION_GET, (_e, id: string) => kbAskSessionRepo.get(id), argsSchema(idSchema))
  safeHandle(IPC.KB_ASK_SESSION_DELETE, (_e, id: string) => {
    kbAskSessionRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))

  // ---------- KB 问答会话重命名 ----------
  safeHandle(IPC.KB_ASK_SESSION_RENAME, (_e, id: string, title: string) => {
    kbAskSessionRepo.rename(id, title)
    return { ok: true }
  }, argsSchema(idSchema, z.string().min(1).max(200)))

  // ---------- KB 问答会话导出 Markdown（主进程从 DB 拉取后构建存盘） ----------
  safeHandle(IPC.KB_ASK_SESSION_EXPORT_MD, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const rec = kbAskSessionRepo.get(id)
    if (!rec) return { ok: false, error: '会话不存在' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName(rec.title)}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    const md = buildKbAskSessionMarkdown(rec, rec.messages)
    fs.writeFileSync(filePath, md, 'utf8')
    return { ok: true, path: filePath }
  }, argsSchema(idSchema))

  // ---------- KB 问答会话导出 HTML（渲染端构建后传主进程存盘） ----------
  safeHandle(IPC.KB_ASK_SESSION_EXPORT_HTML, async (e, id: string, html: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const rec = kbAskSessionRepo.get(id)
    if (!rec) return { ok: false, error: '会话不存在' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName(rec.title)}.html`,
      filters: [
        { name: 'HTML 网页', extensions: ['html'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    fs.writeFileSync(filePath, html, 'utf8')
    return { ok: true, path: filePath }
  }, argsSchema(idSchema, z.string().min(1).max(50 * 1024 * 1024)))

  // ---------- KB 问答会话搜索（LIKE 匹配标题/消息体，空串返回全部） ----------
  safeHandle(
    IPC.KB_ASK_SESSION_SEARCH,
    (_e, kbId: string, keyword: string) => kbAskSessionRepo.searchByKb(kbId, keyword),
    argsSchema(idSchema, z.string().max(200))
  )

  // ---------- KB 问答历史跨库漫游（限量 1-500，默认 200） ----------
  safeHandle(
    IPC.KB_ASK_SESSION_LIST_ALL,
    (_e, limit: number) => kbAskSessionRepo.listAll(limit),
    argsSchema(z.number().int().min(1).max(500))
  )
  safeHandle(
    IPC.KB_ASK_SESSION_SEARCH_ALL,
    (_e, keyword: string, limit: number) => kbAskSessionRepo.searchAll(keyword, limit),
    argsSchema(z.string().max(200), z.number().int().min(1).max(500))
  )

  // ---------- KB 问答历史自动清理策略（双 0 = 关闭） ----------
  const kbAskRetentionSchema = z.object({
    keepCount: z.number().int().min(0).max(10000),
    keepDays: z.number().int().min(0).max(3650)
  })
  safeHandle(IPC.KB_ASK_RETENTION_GET, () => getKbAskRetention())
  safeHandle(IPC.KB_ASK_RETENTION_SET, (_e, policy: { keepCount: number; keepDays: number }) => {
    setKbAskRetention(policy)
    return { ok: true }
  }, argsSchema(kbAskRetentionSchema))

  // ---------- 增量同步：检测 file 文档源文件变更 ----------
  safeHandle(IPC.KB_SYNC_CHECK, (_e, kbId: string) => checkKbFileUpdates(kbId), argsSchema(idSchema))

  // ---------- 文档级检索开关 ----------
  safeHandle(
    IPC.KB_DOC_SET_ENABLED,
    (_e, _kbId: string, docId: string, enabled: boolean) => {
      kbDocRepo.setEnabled(docId, enabled)
      return { ok: true }
    },
    argsSchema(idSchema, idSchema, z.boolean()),
  )
}
