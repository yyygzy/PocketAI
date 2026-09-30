// 会话管理 IPC：增删改查 / 导出（JSON / Markdown / 加密包）/ 导入 / Fork
import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type ConversationExportPayload } from '../../../shared/types'
import { buildConversationMarkdown, safeFileName, dedupeFileNames } from '../../../shared/export-markdown'
import { dbService } from '../../db/database'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { messageRepo } from '../../db/repositories/message.repo'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { encryptWithPassword, decryptWithPassword } from '../../crypto/portable-crypto'
import { htmlToPdf } from '../../export/pdf'
import { errMsg } from '../../error'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { clearSessionAllow } from '../../agent/tool-approval'
import {
  conversationExportPayloadSchema,
  conversationImportDataSchema,
  conversationListArgsSchema,
  conversationCreateArgsSchema,
  CONVERSATION_IMPORT_MAX_FILE_BYTES
} from '../../../shared/schemas/conversations'
import { idSchema } from '../../../shared/schemas/providers'
import { isSmartTitleEnabled, setSmartTitleEnabled } from '../../conversation/title-config'

export function registerConversationHandlers(): void {
  safeHandle(IPC.CONVERSATION_LIST, (_e, assistantId?: string, isAgent?: boolean, archivedOnly?: boolean) =>
    conversationRepo.list(assistantId, isAgent, { archivedOnly }),
  conversationListArgsSchema)
  safeHandle(IPC.CONVERSATION_SET_PINNED, (_e, id: string, pinned: boolean) => {
    conversationRepo.setPinned(String(id ?? ''), pinned)
    return { ok: true }
  }, argsSchema(idSchema, z.boolean()))
  safeHandle(IPC.CONVERSATION_SET_ARCHIVED, (_e, id: string, archived: boolean) => {
    conversationRepo.setArchived(String(id ?? ''), archived)
    return { ok: true }
  }, argsSchema(idSchema, z.boolean()))
  safeHandle(IPC.CONVERSATION_CREATE, (_e, assistantId?: string | null, title?: string) =>
    conversationRepo.create({ assistantId, title }),
  conversationCreateArgsSchema)
  safeHandle(IPC.CONVERSATION_DELETE, (_e, id: string) => {
    conversationRepo.delete(id)
    clearSessionAllow(id) // 清会话级工具「总是允许」白名单
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.CONVERSATION_RENAME, (_e, id: string, title: string) => {
    conversationRepo.rename(id, title)
    return { ok: true }
  }, argsSchema(idSchema, z.string()))
  safeHandle(IPC.CONVERSATION_SMART_TITLE_GET, () => isSmartTitleEnabled())
  safeHandle(IPC.CONVERSATION_SMART_TITLE_SET, (_e, enabled: boolean) => {
    setSmartTitleEnabled(enabled)
    return { ok: true }
  }, argsSchema(z.boolean()))
  safeHandle(IPC.CONVERSATION_EXPORT, (_e, id: string) => {
    const conv = conversationRepo.get(id)
    if (!conv) return { ok: false, error: '会话不存在' }
    const messages = messageRepo.listByConversation(id)
    const assistant = conv.assistantId ? assistantRepo.get(conv.assistantId) ?? null : null
    return {
      ok: true,
      data: {
        version: 1,
        exportedAt: Date.now(),
        conversation: conv,
        messages,
        assistant
      }
    }
  }, argsSchema(idSchema))
  safeHandle(IPC.CONVERSATION_EXPORT_MD, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const conv = conversationRepo.get(String(id ?? ''))
    if (!conv) return { ok: false, error: '会话不存在' }
    const messages = messageRepo.listByConversation(String(id ?? ''))
    const assistant = conv.assistantId ? assistantRepo.get(conv.assistantId) ?? null : null

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName(conv.title)}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    const md = buildConversationMarkdown(conv, messages, assistant?.name ?? null)
    fs.writeFileSync(filePath, md, 'utf8')
    return { ok: true, path: filePath }
  }, argsSchema(idSchema))

  // HTML 内容由渲染端生成（复用应用内 Markdown 管线，零新依赖），主进程只负责选路径存盘
  safeHandle(IPC.CONVERSATION_EXPORT_HTML, async (e, id: string, html: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const conv = conversationRepo.get(String(id ?? ''))
    if (!conv) return { ok: false, error: '会话不存在' }

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName(conv.title)}.html`,
      filters: [
        { name: 'HTML 网页', extensions: ['html'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    fs.writeFileSync(filePath, html, 'utf8')
    return { ok: true, path: filePath }
  }, argsSchema(idSchema, z.string().min(1).max(50 * 1024 * 1024)))

  // 批量导出：渲染端生成全部文件内容，主进程选目录统一写入（重名自动加序号）
  safeHandle(IPC.CONVERSATION_EXPORT_BATCH, async (e, files: Array<{ name: string; content: string }>) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: '没有可导出的会话' }

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths?.[0]) return { ok: true, canceled: true }
    const dir = filePaths[0]

    const finalNames = dedupeFileNames(files.map((f) => safeFileName(f.name)))
    let count = 0
    const failed: string[] = []
    files.forEach((f, i) => {
      try {
        fs.writeFileSync(path.join(dir, finalNames[i]!), f.content, 'utf8')
        count++
      } catch {
        failed.push(f.name)
      }
    })
    return { ok: true, count, dir, failed }
  }, argsSchema(z.array(z.object({
    name: z.string().min(1).max(200),
    content: z.string().max(50 * 1024 * 1024)
  })).min(1).max(500)))

  // 单条导出 PDF：渲染端生成自包含 HTML，主进程隐藏窗口 printToPDF 后存盘（见 export/pdf.ts）
  safeHandle(IPC.CONVERSATION_EXPORT_PDF, async (e, id: string, html: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const conv = conversationRepo.get(String(id ?? ''))
    if (!conv) return { ok: false, error: '会话不存在' }

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeFileName(conv.title)}.pdf`,
      filters: [
        { name: 'PDF 文档', extensions: ['pdf'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    try {
      const pdf = await htmlToPdf(html)
      fs.writeFileSync(filePath, Buffer.from(pdf))
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }, argsSchema(idSchema, z.string().min(1).max(50 * 1024 * 1024)))

  // 批量导出 PDF：同 EXPORT_BATCH 模式（选目录/重名加序号/单文件失败计 failed），
  // 但逐会话 printToPDF 耗时 ~1s/个，数组上限收紧到 50（渲染端多选通道同限）
  safeHandle(IPC.CONVERSATION_EXPORT_PDF_BATCH, async (e, files: Array<{ name: string; content: string }>) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: '没有可导出的会话' }

    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (canceled || !filePaths?.[0]) return { ok: true, canceled: true }
    const dir = filePaths[0]

    const finalNames = dedupeFileNames(files.map((f) => safeFileName(f.name)))
    let count = 0
    const failed: string[] = []
    // 串行转换：隐藏窗口单例 + 队列在 htmlToPdf 内部，这里顺序 await 即可
    for (let i = 0; i < files.length; i++) {
      try {
        const pdf = await htmlToPdf(files[i]!.content)
        fs.writeFileSync(path.join(dir, finalNames[i]!), Buffer.from(pdf))
        count++
      } catch {
        failed.push(files[i]!.name)
      }
    }
    return { ok: true, count, dir, failed }
  }, argsSchema(z.array(z.object({
    name: z.string().min(1).max(200),
    content: z.string().min(1).max(50 * 1024 * 1024)
  })).min(1).max(50)))

  safeHandle(IPC.CONVERSATION_EXPORT_ENCRYPTED, async (e, id: string, password: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const conv = conversationRepo.get(String(id ?? ''))
    if (!conv) return { ok: false, error: '会话不存在' }
    const messages = messageRepo.listByConversation(String(id ?? ''))
    const assistant = conv.assistantId ? assistantRepo.get(conv.assistantId) ?? null : null

    const payload = {
      version: 1,
      exportedAt: Date.now(),
      conversation: conv,
      messages,
      assistant
    }
    const encrypted = encryptWithPassword(password, JSON.stringify(payload))

    const safeName = safeFileName(conv.title)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeName}.moxia`,
      filters: [
        { name: 'Moxia 加密文件', extensions: ['moxia'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    fs.writeFileSync(filePath, encrypted)
    return { ok: true, path: filePath }
  }, argsSchema(idSchema, z.string().min(1)))
  safeHandle(IPC.CONVERSATION_IMPORT_ENCRYPTED, async (e, password: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: '窗口不可用' }
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Moxia 加密文件', extensions: ['moxia'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePaths?.length) return { ok: true, canceled: true }

    // 文件大小预检：解密需要完整载入内存，先挡掉数 GB 的伪造文件
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePaths[0]!)
    } catch {
      return { ok: false, error: '无法读取所选文件' }
    }
    if (!stat.isFile() || stat.size > CONVERSATION_IMPORT_MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `文件过大或不是有效文件（上限 ${Math.floor(CONVERSATION_IMPORT_MAX_FILE_BYTES / 1024 / 1024)}MB）`
      }
    }

    const blob = fs.readFileSync(filePaths[0]!)
    const plaintext = decryptWithPassword(password, blob)
    let raw: unknown
    try {
      raw = JSON.parse(plaintext)
    } catch {
      return { ok: false, error: '文件已损坏（解密成功但内容不是有效 JSON）' }
    }

    // 解密只保证密文真实性，不保证内容善意：按导入边界 schema 逐字段校验
    const parsed = conversationImportDataSchema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const path = issue?.path?.join('.') || '内容'
      return { ok: false, error: `无效的加密文件内容：${path} ${issue?.message ?? '校验失败'}` }
    }
    const payload = parsed.data
    const c = payload.conversation
    const newConv = conversationRepo.create({
      assistantId: c.assistantId ?? null,
      title: (c.title ?? '导入的会话') + ' (加密导入)',
      modelLabel: c.modelLabel ?? undefined,
      titleDefault: false
    })

    // 事务原子写入：中途失败回滚，不留下半个导入会话
    const handle = dbService.getHandle()
    let count = 0
    const tx = handle.transaction((msgs: typeof payload.messages) => {
      for (const m of msgs) {
        handle.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          newConv.id,
          m.role,
          m.content ?? '',
          m.provider ?? null,
          m.model ?? null,
          m.status ?? 'done',
          null,
          m.createdAt ?? Date.now()
        )
        count++
      }
    })
    try {
      tx(payload.messages)
    } catch (e) {
      conversationRepo.delete(newConv.id)
      return { ok: false, error: `导入写入失败，已回滚：${errMsg(e)}` }
    }
    return { ok: true, conversationId: newConv.id, messageCount: count }
  }, argsSchema(z.string().min(1)))
  safeHandle(IPC.CONVERSATION_IMPORT, (_e, payload: ConversationExportPayload) => {
    if (!payload?.conversation || !Array.isArray(payload.messages)) {
      return { ok: false, error: '无效的导出格式' }
    }
    const c = payload.conversation
    const newConv = conversationRepo.create({
      assistantId: c.assistantId ?? null,
      title: (c.title ?? '导入的会话') + ' (导入)',
      modelLabel: c.modelLabel ?? undefined,
      titleDefault: false
    })
    // 为每条消息生成新 UUID + 构建 oldId→newId 映射（处理 parentId 链）
    const idMap = new Map<string, string>()
    for (const m of payload.messages) {
      const oldId: string = m.id
      if (oldId) idMap.set(oldId, randomUUID())
    }
    const handle = dbService.getHandle()
    const tx = handle.transaction((msgs: ConversationExportPayload['messages']) => {
      for (const m of msgs) {
        const newId = idMap.get(m.id) ?? randomUUID()
        const newParent = m.parentId ? idMap.get(m.parentId) ?? null : null
        handle.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId,
          newConv.id,
          m.role,
          m.content ?? '',
          m.provider ?? null,
          m.model ?? null,
          m.status ?? 'done',
          newParent,
          m.createdAt ?? Date.now()
        )
      }
    })
    tx(payload.messages)
    return { ok: true, conversationId: newConv.id, messageCount: payload.messages.length }
  }, argsSchema(conversationExportPayloadSchema))
  safeHandle(IPC.CONVERSATION_FORK, (_e, conversationId: string, messageId: string) => ({
    ok: true as const,
    conversation: conversationRepo.fork(conversationId, messageId)
  }), argsSchema(idSchema, idSchema))
}

