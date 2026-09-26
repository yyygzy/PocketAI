// 会话管理 IPC：增删改查 / 导出（JSON / Markdown / 加密包）/ 导入 / Fork
import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { IPC, type ConversationExportPayload } from '../../../shared/types'
import { dbService } from '../../db/database'
import { conversationRepo } from '../../db/repositories/conversation.repo'
import { messageRepo } from '../../db/repositories/message.repo'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { encryptWithPassword, decryptWithPassword } from '../../crypto/portable-crypto'
import { safeHandle, argsSchema, z } from '../safe-handle'
import {
  conversationExportPayloadSchema,
  conversationListArgsSchema,
  conversationCreateArgsSchema
} from '../../../shared/schemas/conversations'
import { idSchema } from '../../../shared/schemas/providers'

export function registerConversationHandlers(): void {
  safeHandle(IPC.CONVERSATION_LIST, (_e, assistantId?: string, isAgent?: boolean) =>
    conversationRepo.list(assistantId, isAgent),
  conversationListArgsSchema)
  safeHandle(IPC.CONVERSATION_CREATE, (_e, assistantId?: string | null, title?: string) =>
    conversationRepo.create({ assistantId, title }),
  conversationCreateArgsSchema)
  safeHandle(IPC.CONVERSATION_DELETE, (_e, id: string) => {
    conversationRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.CONVERSATION_RENAME, (_e, id: string, title: string) => {
    conversationRepo.rename(id, title)
    return { ok: true }
  }, argsSchema(idSchema, z.string()))
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

    const safeName = conv.title.replace(/[<>:"/\\|?*]/g, '_').trim() || 'conversation'
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: `${safeName}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }

    const md = renderConversationToMarkdown(conv, messages)
    fs.writeFileSync(filePath, md, 'utf8')
    return { ok: true, path: filePath }
  }, argsSchema(idSchema))
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

    const safeName = conv.title.replace(/[<>:"/\\|?*]/g, '_').trim() || 'conversation'
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

    const blob = fs.readFileSync(filePaths[0]!)
    const plaintext = decryptWithPassword(password, blob)
    let payload: ConversationExportPayload
    try {
      payload = JSON.parse(plaintext) as ConversationExportPayload
    } catch {
      return { ok: false, error: '文件已损坏（解密成功但内容不是有效 JSON）' }
    }

    if (!payload?.conversation || !Array.isArray(payload.messages)) {
      return { ok: false, error: '无效的加密文件内容' }
    }

    const c = payload.conversation
    const newConv = conversationRepo.create({
      assistantId: c.assistantId ?? null,
      title: (c.title ?? '导入的会话') + ' (加密导入)',
      modelLabel: c.modelLabel ?? undefined
    })
    let count = 0
    for (const m of payload.messages) {
      messageRepo.insert({
        conversationId: newConv.id,
        role: m.role,
        content: m.content ?? '',
        provider: m.provider ?? null,
        model: m.model ?? null,
        parentId: null
      })
      count++
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
      modelLabel: c.modelLabel ?? undefined
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

// ==========================================================================
// Markdown 导出辅助函数
// ==========================================================================

/** 把单条消息内容里的多行文本包裹成代码块，避免 Markdown 排版错乱 */
function escapeMdCodeBlock(text: string): string {
  if (!text) return ''
  // 如果本身就有 ``` fence，改用 ~~~ fence 避免冲突
  if (text.includes('```')) {
    return '~~~\n' + text.trimEnd() + '\n~~~'
  }
  return text.trimEnd()
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user': return '👤 用户'
    case 'assistant': return '🤖 助手'
    case 'system': return '⚙️ 系统'
    case 'tool': return '🔧 工具'
    default: return role
  }
}

function renderConversationToMarkdown(
  conv: { title: string; modelLabel: string | null; createdAt: number; updatedAt: number },
  messages: { role: string; content: string; createdAt: number; toolCalls?: string | null }[]
): string {
  const dateFmt = (ts: number) => new Date(ts).toLocaleString()

  const lines: string[] = []
  lines.push(`# ${conv.title}`)
  lines.push('')
  lines.push(`> **模型**: \`${conv.modelLabel ?? '未知'}\``)
  lines.push(`> **创建时间**: ${dateFmt(conv.createdAt)}`)
  lines.push(`> **最后更新**: ${dateFmt(conv.updatedAt)}`)
  lines.push(`> **消息数**: ${messages.length}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of messages) {
    lines.push(`## ${roleLabel(msg.role)} — ${dateFmt(msg.createdAt)}`)
    lines.push('')

    // 工具调用信息
    if (msg.toolCalls) {
      try {
        const calls = JSON.parse(msg.toolCalls)
        if (Array.isArray(calls) && calls.length > 0) {
          lines.push('**Tool Calls**:')
          for (const c of calls) {
            lines.push(`- \`${c.function?.name ?? c.name ?? 'unknown'}\` → ${escapeMdCodeBlock(c.function?.arguments ?? JSON.stringify(c, null, 2))}`)
          }
          lines.push('')
        }
      } catch {
        lines.push('**Tool Calls**:')
        lines.push(escapeMdCodeBlock(msg.toolCalls))
        lines.push('')
      }
    }

    if (msg.content) {
      lines.push(escapeMdCodeBlock(msg.content))
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}
