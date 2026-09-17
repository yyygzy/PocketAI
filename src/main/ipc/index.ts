// IPC 路由注册
import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/types'
import type {
  ProviderRecord,
  SendMessagePayload,
  AssistantRecord,
  KnowledgeBase,
  McpServerRecord,
  SkillRecord
} from '../../shared/types'
import { getPaths } from '../portable'
import { getHardwareInfo } from '../steward/hardware'
import { buildAppMenu } from '../menu'
import { dbService } from '../db/database'
import { providerRepo } from '../db/repositories/provider.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { skillRepo } from '../db/repositories/skill.repo'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { providerManager } from '../providers/manager'
import { chatService } from '../chat/chat-service'
import { kbRepo } from '../db/repositories/kb.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../db/repositories/kb-chunk.repo'
import { ingestionService } from '../knowledge/ingestion'
import { ragService } from '../knowledge/rag'
import { detectSourceType } from '../knowledge/parsers'
import { mcpServerRepo } from '../db/repositories/mcp-server.repo'
import { mcpManager } from '../mcp/manager'
import { toolRegistry } from '../tools/registry'
import { licenseService } from '../license/license'
import { lockService } from '../lock/lock'
import { healthService } from '../health/health'
import { filesService } from '../files/files-service'
import { masterKeyManager } from '../crypto/master-key'
import { unlockCoordinator } from '../crypto/unlock-coordinator'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import path from 'node:path'
import { DATA_DIR } from '../portable'

/** 向所有 BrowserWindow 推送事件 */
function broadcast(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

export function registerIpcHandlers(): void {
  // ---------- 系统 ----------
  ipcMain.handle(IPC.SYSTEM_HARDWARE_INFO, () => getHardwareInfo())
  ipcMain.handle(IPC.APP_GET_PATHS, () => getPaths())
  ipcMain.handle(IPC.MENU_SET_LANGUAGE, (_e, lang: string) => {
    buildAppMenu(lang === 'en' ? 'en' : 'zh')
    return { ok: true }
  })
  ipcMain.handle(IPC.DB_RUN_MIGRATIONS, () => {
    dbService.runMigrations()
    return { ok: true }
  })
  ipcMain.handle(IPC.DB_INTEGRITY_CHECK, () => dbService.integrityCheck())

  // ---------- Provider ----------
  ipcMain.handle(IPC.PROVIDER_LIST, () => providerRepo.list())

  ipcMain.handle(IPC.PROVIDER_SAVE, (_e, record: ProviderRecord) => {
    const saved = providerRepo.save(record)
    providerManager.invalidate(saved.id)
    return saved
  })

  ipcMain.handle(IPC.PROVIDER_DELETE, (_e, id: string) => {
    providerRepo.delete(id)
    providerManager.invalidate(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.PROVIDER_FETCH_MODELS, (_e, id: string) =>
    providerManager.fetchModels(id)
  )

  ipcMain.handle(IPC.PROVIDER_TEST, (_e, id: string) => providerManager.test(id))

  // ---------- 助手 ----------
  ipcMain.handle(IPC.ASSISTANT_LIST, () => assistantRepo.list())
  ipcMain.handle(IPC.ASSISTANT_GET, (_e, id: string) => assistantRepo.get(id))
  ipcMain.handle(IPC.ASSISTANT_SAVE, (_e, record: Partial<AssistantRecord> & { name: string }) =>
    assistantRepo.save(record)
  )
  ipcMain.handle(IPC.ASSISTANT_DELETE, (_e, id: string) => {
    assistantRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.ASSISTANT_DUPLICATE, (_e, id: string) => assistantRepo.duplicate(id))
  ipcMain.handle(IPC.ASSISTANT_SET_PINNED, (_e, id: string, pinned: boolean) => {
    assistantRepo.setPinned(id, pinned)
    return { ok: true }
  })

  // ---------- 技能 ----------
  ipcMain.handle(IPC.SKILL_LIST, () => skillRepo.list())
  ipcMain.handle(IPC.SKILL_GET, (_e, id: string) => skillRepo.get(id))
  ipcMain.handle(IPC.SKILL_SAVE, (_e, record: Partial<SkillRecord> & { name: string }) =>
    skillRepo.save(record)
  )
  ipcMain.handle(IPC.SKILL_DELETE, (_e, id: string) => {
    skillRepo.delete(id)
    return { ok: true }
  })

  // ---------- 会话 ----------
  ipcMain.handle(IPC.CONVERSATION_LIST, (_e, assistantId?: string) =>
    conversationRepo.list(assistantId)
  )
  ipcMain.handle(IPC.CONVERSATION_CREATE, (_e, assistantId?: string | null) =>
    conversationRepo.create({ assistantId })
  )
  ipcMain.handle(IPC.CONVERSATION_DELETE, (_e, id: string) => {
    conversationRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.CONVERSATION_RENAME, (_e, id: string, title: string) => {
    conversationRepo.rename(id, title)
    return { ok: true }
  })
  ipcMain.handle(IPC.CONVERSATION_EXPORT, (_e, id: string) => {
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
  })
  ipcMain.handle(IPC.CONVERSATION_IMPORT, (_e, payload: any) => {
    if (!payload?.conversation || !Array.isArray(payload.messages)) {
      return { ok: false, error: '无效的导出格式' }
    }
    const c = payload.conversation
    const newConv = conversationRepo.create({
      assistantId: c.assistantId ?? null,
      title: (c.title ?? '导入的会话') + ' (导入)',
      modelLabel: c.modelLabel
    })
    // 为每条消息生成新 UUID + 构建 oldId→newId 映射（处理 parentId 链）
    const idMap = new Map<string, string>()
    for (const m of payload.messages) {
      const oldId: string = m.id
      if (oldId) idMap.set(oldId, randomUUID())
    }
    const handle = dbService.getHandle()
    const tx = handle.transaction((msgs: any[]) => {
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
  })

  // ---------- 消息 ----------
  ipcMain.handle(IPC.MESSAGE_LIST, (_e, conversationId: string) =>
    messageRepo.listByConversation(conversationId)
  )
  ipcMain.handle(IPC.MESSAGE_SEARCH, (_e, query: string) => {
    if (!query || query.trim().length < 1) return []
    const q = query.trim()
    const handle = dbService.getHandle()
    const limit = 50
    // HTML escape — 防 XSS（用户消息里可能有 <script> 等）
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    // 先 FTS5 MATCH（trigram，中文 3+ 字）
    try {
      const ftsSql = `
        SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
               m.created_at, c.title AS conversation_title,
               snippet(messages_fts, 0, '[b]', '[/b]', '…', 128) AS snippet
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `
      const rows = handle.prepare(ftsSql).all(q, limit) as any[]
      if (rows.length > 0) {
        return rows.map(r => {
          // snippet() 用 [b] 标记 — 先 escape 非标记部分，再替换 [b]→<b>
          const raw = r.snippet ?? ''
          const escaped = esc(raw).replace(/\[b\]/g, '<b>').replace(/\[\/b\]/g, '</b>')
          return {
            messageId: r.msg_id,
            conversationId: r.conversation_id,
            conversationTitle: esc(r.conversation_title ?? ''),
            role: r.role,
            content: r.content,
            snippet: escaped,
            createdAt: r.created_at
          }
        })
      }
    } catch { /* FTS5 未创建等情况 → 忽略，走 LIKE */ }

    // Fallback: LIKE 兜底（中文 1-2 字、特殊字符等）
    const likeSql = `
      SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
             m.created_at, c.title AS conversation_title
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `
    const like = `%${q.replace(/[%_]/g, '\\$&')}%`
    const rows = handle.prepare(likeSql).all(like, limit) as any[]
    const safeQ = esc(q)
    return rows.map(r => {
      const safeContent = esc(r.content ?? '')
      const lowerSafeContent = safeContent.toLowerCase()
      const lowerSafeQ = safeQ.toLowerCase()
      const idx = lowerSafeContent.indexOf(lowerSafeQ)
      let snippet: string
      if (idx >= 0) {
        const start = Math.max(0, idx - 30)
        const end = Math.min(safeContent.length, idx + safeQ.length + 60)
        const before = start > 0 ? '…' : ''
        const after = end < safeContent.length ? '…' : ''
        snippet = before + safeContent.slice(start, idx) + '<b>' + safeQ + '</b>' + safeContent.slice(idx + safeQ.length, end) + after
      } else {
        snippet = safeContent.slice(0, 128)
      }
      return {
        messageId: r.msg_id,
        conversationId: r.conversation_id,
        conversationTitle: esc(r.conversation_title ?? ''),
        role: r.role,
        content: r.content,
        snippet,
        createdAt: r.created_at
      }
    })
  })

  // ---------- 聊天（流式事件通过 sender 推送） ----------
  ipcMain.handle(IPC.CHAT_SEND, (event, payload: SendMessagePayload) => {
    const sender: WebContents = event.sender
    return chatService.send(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  })

  ipcMain.handle(IPC.CHAT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  })

  // ---------- 知识库 ----------
  ipcMain.handle(IPC.KB_LIST, () => kbRepo.list())
  ipcMain.handle(IPC.KB_GET, (_e, id: string) => kbRepo.get(id))
  ipcMain.handle(IPC.KB_SAVE, (_e, record: Partial<KnowledgeBase> & { name: string }) =>
    kbRepo.save(record)
  )
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
      // 复用 ingestDocument 但需先把文本落盘为临时文件——这里直接走 ingestDocument，
      // 但 source 是 title 不是文件路径，会失败。改用直接注入文本的方式：
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

  // ---------- MCP Server ----------
  ipcMain.handle(IPC.MCP_SERVER_LIST, () => mcpServerRepo.list())
  ipcMain.handle(IPC.MCP_SERVER_GET, (_e, id: string) => mcpServerRepo.get(id))
  ipcMain.handle(IPC.MCP_SERVER_SAVE, (_e, record: Partial<McpServerRecord> & { name: string }) =>
    mcpServerRepo.save(record)
  )
  ipcMain.handle(IPC.MCP_SERVER_DELETE, async (_e, id: string) => {
    await mcpManager.stop(id)
    mcpServerRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.MCP_SERVER_START, async (_e, id: string) => {
    try {
      const runtime = await mcpManager.start(id)
      return { ok: true, runtime }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.MCP_SERVER_STOP, async (_e, id: string) => {
    await mcpManager.stop(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.MCP_SERVER_RESTART, async (_e, id: string) => {
    try {
      const runtime = await mcpManager.restart(id)
      return { ok: true, runtime }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.MCP_SERVER_LIST_TOOLS, async (_e, id: string) => {
    try {
      return { ok: true, tools: await mcpManager.listTools(id) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.MCP_SERVER_GET_RUNTIMES, () => mcpManager.listRuntimes())

  // MCP 状态变化 / 日志事件 → 广播给所有窗口
  mcpManager.onStatus((evt) => broadcast(IPC.MCP_SERVER_STATUS_EVENT, evt))
  mcpManager.onLog((evt) => broadcast(IPC.MCP_SERVER_LOG_EVENT, evt))

  // ---------- 工具 ----------
  ipcMain.handle(IPC.TOOL_LIST_AVAILABLE, () => toolRegistry.listAll())

  // ---------- Work Agent ----------
  // AGENT_* 事件通过 chat:send 的 emit 推送到对应 sender
  // 这里仅注册一个 abort 通道
  ipcMain.handle(IPC.AGENT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  })

  // ---------- License 授权 ----------
  ipcMain.handle(IPC.LICENSE_GET_STATUS, () => licenseService.getStatus())
  ipcMain.handle(IPC.LICENSE_LOAD_FILE, (_e, filePath: string) =>
    licenseService.loadFromFile(filePath)
  )
  ipcMain.handle(IPC.LICENSE_LOAD_STRING, (_e, content: string) =>
    licenseService.loadFromString(content)
  )
  ipcMain.handle(IPC.LICENSE_CLEAR, () => {
    licenseService.clear()
    return { ok: true }
  })
  ipcMain.handle(IPC.LICENSE_HAS_FEATURE, (_e, feature: string) =>
    licenseService.hasFeature(feature)
  )

  // ---------- 加密 ----------
  ipcMain.handle(IPC.ENCRYPTION_GET_STATUS, () => ({
    mode: masterKeyManager.getMode(),
    unlocked: masterKeyManager.hasKey(),
    dbEncrypted: masterKeyManager.isDbEncrypted(),
    fieldEncrypted: masterKeyManager.hasKey(),
    masterPasswordVerified: masterKeyManager.hasKey()
  }))
  ipcMain.handle(IPC.ENCRYPTION_UNLOCK, (_e, password: string) => {
    unlockCoordinator.submit({ password })
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_SET_MASTER_PASSWORD, (_e, password: string) => {
    unlockCoordinator.submit({ setPassword: password })
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_LOCK, () => {
    masterKeyManager.clear()
    dbService.close()
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_CHANGE_PASSWORD, async (_e, oldPassword: string, newPassword: string) => {
    // 密码轮换：用旧密码打开 → rekey → 更新 salt
    const salt = appConfigRepo.getMasterPasswordSalt()
    const oldKey = masterKeyManager.setKey(oldPassword, salt ?? undefined)
    // 验证旧密码正确
    if (!dbService.getHandle()) {
      dbService.open(oldKey)
    }
    try {
      dbService.getHandle().prepare('SELECT 1').get()
    } catch {
      return { ok: false, error: '旧密码错误' }
    }
    // ⚠️ key 还没切换，先用旧 key 取出 WebDAV 明文密码
    let webDAVPassword: string | null = null
    let savedCfg: any = null
    try {
      const { loadWebDAVConfig } = await import('../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 无配置或解密失败，忽略 */ }

    // rekey
    dbService.getHandle().pragma('journal_mode = DELETE')
    const newSalt = masterKeyManager.generateSalt()
    appConfigRepo.setMasterPasswordSalt(newSalt)
    const newKey = masterKeyManager.setKey(newPassword, newSalt)
    const hex = newKey.toString('hex')
    dbService.getHandle().pragma(`rekey = "x'${hex}'"`)
    // 重新打开
    dbService.close()
    dbService.open(newKey)
    dbService.getHandle().pragma('journal_mode = WAL')

    // ⚠️ key 已切换，用新 key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 直接复用 oldCfg，避免第二次 load 时 key mismatch
      } catch (e) { console.warn('[encryption] WebDAV 凭据重加密失败:', e) }
    }

    console.log('[encryption] 密码轮换成功')
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_DISABLE, async (_e, password: string) => {
    // 禁用加密：用密码验证 → rekey 空密码 → 清 app_config
    const salt = appConfigRepo.getMasterPasswordSalt()
    masterKeyManager.setKey(password, salt ?? undefined)
    if (!dbService.getHandle()) {
      dbService.open(masterKeyManager.getDbKey()!)
    }
    // ⚠️ key 还没切换，先用 master key 取出 WebDAV 明文密码
    let webDAVPassword: string | null = null
    let savedCfg: any = null
    try {
      const { loadWebDAVConfig } = await import('../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 忽略 */ }

    dbService.getHandle().pragma('journal_mode = DELETE')
    dbService.getHandle().pragma("rekey = ''")
    dbService.close()
    masterKeyManager.init('none')  // ← key 切换为 fixed key
    dbService.open()
    appConfigRepo.setEncryptionMode('none')
    appConfigRepo.setHasMasterPassword(false)
    appConfigRepo.delete('master_password_salt')
    console.log('[encryption] 已禁用加密')

    // ⚠️ key 已切为 fixed，用 fixed key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 复用 oldCfg，避免 key mismatch
      } catch (e) { console.warn('[encryption] WebDAV 凭据重加密失败:', e) }
    }
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_ENABLE, async (_e, password: string) => {
    // 设置页启用加密（DB 当前是明文打开状态）
    if (masterKeyManager.isDbEncrypted()) {
      return { ok: false, error: '已经加密' }
    }
    // ⚠️ 当前是 fixed key 模式，先取出 WebDAV 明文密码
    let webDAVPassword: string | null = null
    let savedCfg: any = null
    try {
      const { loadWebDAVConfig } = await import('../backup/backup-service')
      const oldCfg = loadWebDAVConfig()
      if (oldCfg) { webDAVPassword = oldCfg.passwordCipher; savedCfg = oldCfg }
    } catch { /* 忽略 */ }

    const newSalt = masterKeyManager.generateSalt()
    const masterKey = masterKeyManager.setKey(password, newSalt)  // ← key 切换为 master key
    appConfigRepo.setMasterPasswordSalt(newSalt)
    appConfigRepo.setEncryptionMode('db')
    appConfigRepo.setHasMasterPassword(true)
    dbService.enableEncryption(masterKey)
    console.log('[encryption] 已启用加密')

    // ⚠️ key 已切为 master，用 master key 重新加密 WebDAV 密码
    if (webDAVPassword && savedCfg) {
      try {
        const { saveWebDAVConfig } = await import('../backup/backup-service')
        savedCfg.passwordCipher = webDAVPassword
        saveWebDAVConfig(savedCfg)  // 复用 oldCfg，避免 key mismatch
      } catch (e) { console.warn('[encryption] WebDAV 凭据重加密失败:', e) }
    }
    return { ok: true }
  })

  // ---------- 备份 ----------
  ipcMain.handle(IPC.BACKUP_LOCAL, async () => {
    const { createLocalBackup } = await import('../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    return createLocalBackup(dir)
  })
  ipcMain.handle(IPC.BACKUP_LOCAL_ENCRYPTED, async () => {
    const { createEncryptedLocalBackup } = await import('../backup/backup-service')
    const dir = path.join(DATA_DIR, 'backups')
    return createEncryptedLocalBackup(dir)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_SAVE_CONFIG, async (_e, cfg: any) => {
    const { saveWebDAVConfig } = await import('../backup/backup-service')
    saveWebDAVConfig(cfg)
    return { ok: true }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_LOAD_CONFIG, async () => {
    const { loadWebDAVConfig } = await import('../backup/backup-service')
    return loadWebDAVConfig()
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_TEST, async (_e, cfg: any) => {
    const { testWebDAV } = await import('../backup/backup-service')
    return testWebDAV(cfg)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_UPLOAD, async () => {
    const { loadWebDAVConfig, createWebDAVBackup } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      return await createWebDAVBackup(cfg)
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '上传失败' }
    }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_LIST, async () => {
    const { loadWebDAVConfig, listWebDAVBackups } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return []
    try { return await listWebDAVBackups(cfg) } catch { return [] }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_RESTORE, async (_e, filename: string) => {
    const { loadWebDAVConfig, restoreFromWebDAV } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    return restoreFromWebDAV(cfg, filename)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_DELETE, async (_e, filename: string) => {
    const { loadWebDAVConfig, deleteWebDAVBackup } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    await deleteWebDAVBackup(cfg, filename)
    return { ok: true }
  })

  // ---------- 隐私锁 ----------
  ipcMain.handle(IPC.LOCK_GET_STATUS, () => lockService.getStatus())
  ipcMain.handle(IPC.LOCK_LOCK, () => {
    lockService.lock('manual')
    return { ok: true }
  })
  ipcMain.handle(IPC.LOCK_UNLOCK, () => {
    lockService.unlock()
    return { ok: true }
  })
  ipcMain.handle(IPC.LOCK_SET_AUTO_TIMEOUT, (_e, timeoutMs: number) => {
    lockService.setAutoTimeout(timeoutMs)
    return { ok: true }
  })
  // 锁屏状态变化 → 广播
  lockService.onStateChange((evt) => broadcast(IPC.LOCK_STATE_EVENT, evt))

  // ---------- 平台管家 ----------
  ipcMain.handle(IPC.HEALTH_REPORT, () => healthService.report())
  ipcMain.handle(IPC.HEALTH_CLEANUP, () => healthService.cleanup())
  ipcMain.handle(IPC.HEALTH_VACUUM, () => healthService.vacuum())

  // ---------- 文件模块 ----------
  ipcMain.handle(IPC.FILE_LIST, (_e, relDir: string) => filesService.list(relDir))
  ipcMain.handle(IPC.FILE_READ, (_e, relPath: string) => filesService.read(relPath))
  ipcMain.handle(IPC.FILE_UPLOAD, (_e, relDir: string, name: string, base64: string) =>
    filesService.upload(relDir, name, base64)
  )
  ipcMain.handle(IPC.FILE_MKDIR, (_e, relDir: string, name: string) =>
    filesService.mkdir(relDir, name)
  )
  ipcMain.handle(IPC.FILE_DELETE, (_e, relPath: string) => filesService.remove(relPath))
  ipcMain.handle(IPC.FILE_SAVE_AS, (_e, relPath: string) => filesService.saveAs(relPath))
  ipcMain.handle(IPC.FILE_OPEN_LOCATION, (_e, relPath: string) =>
    filesService.openLocation(relPath)
  )
  ipcMain.handle(IPC.FILE_OPEN_EXTERNAL, (_e, relPath: string) =>
    filesService.openExternal(relPath)
  )
}
