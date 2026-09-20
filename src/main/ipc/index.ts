// IPC 路由注册
import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../shared/types'
import type {
  ProviderRecord,
  SendMessagePayload,
  RegeneratePayload,
  ResendPayload,
  AssistantRecord,
  KnowledgeBase,
  McpServerRecord,
  SkillRecord,
  UiPreferences,
  SidebarModuleId,
  TranslateRequestPayload,
  ImageGeneratePayload
} from '../../shared/types'
import { DEFAULT_SIDEBAR_ORDER } from '../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../shared/snippet'
import { getPaths } from '../portable'
import { getHardwareInfo, refreshHardwareInfo } from '../steward/hardware'
import { recommendModels } from '../steward/model-recommend'
import { runAudit, runDiagnose } from '../steward/diagnose'
import { buildAppMenu } from '../menu'
import { dbService } from '../db/database'
import { providerRepo } from '../db/repositories/provider.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { skillRepo } from '../db/repositories/skill.repo'
import { exportSkill, importSkill } from '../skills/skill-io'
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
import { pythonEnvService, getPipSource, setPipSource } from '../mcp/python-env'
import type { PythonPipSource } from '../../shared/types'
import { toolRegistry } from '../tools/registry'
import { getWorkspaceDir, setWorkspaceDir } from '../tools/fs-tools'
import { getShellConfig, setShellConfig } from '../tools/shell-config'
import { getWebSearchConfig, setWebSearchConfig } from '../tools/websearch-config'
import { getChannelConfig, setChannelConfig } from '../channels/channel-config'
import { channelService } from '../channels/channel-service'
import {
  listSandboxFiles,
  createSandboxFile,
  getSandboxFile,
  deleteSandboxFile,
  updateSandboxMeta
} from '../sandbox/sandbox-service'
import { resolveApproval } from '../agent/tool-approval'
import { licenseService } from '../license/license'
import { lockService } from '../lock/lock'
import { denyNewWindows } from '../net/external-links'
import { healthService } from '../health/health'
import { getBackupSchedule, setBackupSchedule, noteManualBackup } from '../backup/backup-scheduler'
import { filesService } from '../files/files-service'
import { masterKeyManager } from '../crypto/master-key'
import { unlockCoordinator } from '../crypto/unlock-coordinator'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { noteRepo } from '../db/repositories/note.repo'
import { translationRepo } from '../db/repositories/translation.repo'
import { imageRepo } from '../db/repositories/image.repo'
import {
  runImageGenerate,
  abortImageGenerate,
  listImages,
  getImageFile,
  deleteImage,
  saveImageAs
} from '../images/image-service'
import { runTranslate, abortTranslate } from '../translate/translate-service'
import { listPythonRuntimes, downloadPortablePython } from '../python-runtime'
import { getUiPreferences, setUiPreferences } from '../ui-preferences'
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
  // force=true 时重新采集（用户手动「重新检测」）；否则返回启动时缓存的快照
  ipcMain.handle(IPC.SYSTEM_HARDWARE_INFO, (_e, force?: boolean) =>
    force ? refreshHardwareInfo() : getHardwareInfo()
  )
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

  // 技能市场：导出/导入（文件对话框在主进程弹出）
  ipcMain.handle(IPC.SKILL_EXPORT, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return exportSkill(win!, id)
  })
  ipcMain.handle(IPC.SKILL_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return importSkill(win!)
  })

  // ---------- 会话 ----------
  ipcMain.handle(IPC.CONVERSATION_LIST, (_e, assistantId?: string, isAgent?: boolean) =>
    conversationRepo.list(assistantId, isAgent)
  )
  ipcMain.handle(IPC.CONVERSATION_CREATE, (_e, assistantId?: string | null, title?: string) =>
    conversationRepo.create({ assistantId, title })
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
  ipcMain.handle(IPC.CONVERSATION_FORK, (_e, conversationId: string, messageId: string) => {
    try {
      const conversation = conversationRepo.fork(conversationId, messageId)
      return { ok: true, conversation }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---------- 消息 ----------
  ipcMain.handle(IPC.MESSAGE_LIST, (_e, conversationId: string) =>
    messageRepo.listByConversation(conversationId)
  )
  ipcMain.handle(IPC.MESSAGE_DELETE, (_e, id: string) => {
    messageRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.MESSAGE_SEARCH, (_e, query: string) => {
    if (!query || query.trim().length < 1) return []
    const q = query.trim()
    const handle = dbService.getHandle()
    const limit = 50
    // 片段是「纯文本 + PUA 高亮令牌」，由渲染层作为 React 文本节点渲染，
    // 不经过 HTML，因此不需要 HTML 转义（React 自动处理）

    // 先 FTS5 MATCH（trigram，中文 3+ 字）
    try {
      const ftsSql = `
        SELECT m.id AS msg_id, m.conversation_id, m.role, m.content,
               m.created_at, c.title AS conversation_title,
               snippet(messages_fts, 0, ?, ?, '…', 128) AS snippet
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE messages_fts MATCH ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `
      const rows = handle.prepare(ftsSql).all(SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE, q, limit) as any[]
      if (rows.length > 0) {
        return rows.map(r => {
          return {
            messageId: r.msg_id,
            conversationId: r.conversation_id,
            // 标题由渲染层作为 React 文本节点渲染（自动转义）
            conversationTitle: r.conversation_title ?? '',
            role: r.role,
            content: r.content,
            snippet: r.snippet ?? '',
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
    const lq = q.toLowerCase()
    return rows.map(r => {
      const content = String(r.content ?? '')
      const idx = content.toLowerCase().indexOf(lq)
      let snippet: string
      if (idx >= 0) {
        const start = Math.max(0, idx - 30)
        const end = Math.min(content.length, idx + q.length + 60)
        const before = start > 0 ? '…' : ''
        const after = end < content.length ? '…' : ''
        snippet = before + content.slice(start, idx) + SNIPPET_MARK_OPEN + content.slice(idx, idx + q.length) + SNIPPET_MARK_CLOSE + content.slice(idx + q.length, end) + after
      } else {
        snippet = content.slice(0, 128)
      }
      return {
        messageId: r.msg_id,
        conversationId: r.conversation_id,
        conversationTitle: r.conversation_title ?? '',
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

  ipcMain.handle(IPC.CHAT_REGENERATE, (event, payload: RegeneratePayload) => {
    const sender: WebContents = event.sender
    return chatService.regenerate(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
  })

  ipcMain.handle(IPC.CHAT_RESEND, (event, payload: ResendPayload) => {
    const sender: WebContents = event.sender
    return chatService.resend(payload, (channel, data) => {
      if (!sender.isDestroyed()) sender.send(channel, data)
    })
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
    // 与安装整段（含前置 stop）共用 per-server 操作锁：安装/重装进行中删除一律拒绝，
    // 避免 pip 进程树占用 venv 造成孤儿目录或静默重建
    try {
      return await pythonEnvService.withServerOp(id, async () => {
        await mcpManager.stop(id)
        // 清理该 Server 的独立 venv 与工作目录；清理失败不阻断 DB 删除（条目没了环境即为孤儿，
        // 下次启动不会再引用），但把警告带回 UI 提示用户可手动删除目录
        let warning: string | undefined
        try {
          await pythonEnvService.removeServerEnv(id)
        } catch (e) {
          warning = `配置已删除，但虚拟环境目录清理失败：${(e as Error).message}`
        }
        mcpServerRepo.delete(id)
        return { ok: true as const, warning }
      })
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
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

  // ---------- Python MCP 依赖环境（venv / pip） ----------
  // 安装：仅显式按钮触发；过程经 PYTHON_ENV_EVENT 广播推送，最终状态在 invoke 返回
  ipcMain.handle(IPC.PYTHON_ENV_INSTALL, async (_e, serverId: string) => {
    // 整段（含前置 stop）持 per-server 操作锁，与删除互斥；并发操作立即失败而非排队
    try {
      return await pythonEnvService.withServerOp(serverId, async () => {
        const record = mcpServerRepo.get(serverId)
        if (!record) return { ok: false as const, error: 'MCP Server 不存在或已被删除' }
        // 重装会重写/删除 venv，运行中的进程会锁住其中的文件（Windows EBUSY）：先停再装，
        // 安装完成后用户需自行重新启动（UI 状态会反映 stopped）。
        await mcpManager.stop(serverId)
        const state = await pythonEnvService.installForServer(record)
        return { ok: true as const, state }
      })
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.PYTHON_ENV_STATUS, async (_e, serverId: string) => {
    // 整体包 try/catch：存量脏数据（如历史保存的非法包行）不应炸成未处理 rejection，
    // 向 UI 返回结构化错误，由表单行内展示
    try {
      const record = mcpServerRepo.get(serverId)
      if (!record) return { ok: false as const, error: 'MCP Server 不存在或已被删除' }
      // 必须 await：getEnvState 是 async（要探测解释器版本），嵌套 Promise 无法被 IPC 结构化克隆
      const state = await pythonEnvService.getEnvState(record)
      return {
        ok: true as const,
        state,
        recentEvents: pythonEnvService.recentEvents(serverId)
      }
    } catch (e) {
      return { ok: false as const, error: `环境状态读取失败：${(e as Error).message}` }
    }
  })
  ipcMain.handle(IPC.PYTHON_PIP_SOURCE_GET, () => ({ ok: true, source: getPipSource() }))
  ipcMain.handle(IPC.PYTHON_PIP_SOURCE_SET, (_e, source: PythonPipSource) => {
    try {
      setPipSource(source)
      return { ok: true, source: getPipSource() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---------- 笔记 ----------
  ipcMain.handle(IPC.NOTES_LIST, () => noteRepo.list())
  ipcMain.handle(IPC.NOTES_GET, (_e, id: string) => noteRepo.get(id))
  ipcMain.handle(
    IPC.NOTES_CREATE,
    (_e, input: { title?: string; content?: string; tags?: string[] }) => noteRepo.create(input ?? {})
  )
  ipcMain.handle(
    IPC.NOTES_UPDATE,
    (
      _e,
      id: string,
      patch: Partial<Pick<import('../../shared/types').Note, 'title' | 'content' | 'pinned'>> & {
        tags?: string[]
      }
    ) => noteRepo.update(id, patch ?? {})
  )
  ipcMain.handle(IPC.NOTES_DELETE, (_e, id: string) => {
    noteRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.NOTES_SEARCH, (_e, keyword: string) => noteRepo.search(keyword ?? ''))
  ipcMain.handle(
    IPC.NOTES_CREATE_FROM_MESSAGE,
    (_e, input: { title?: string; content: string }) => noteRepo.createFromMessage(input)
  )

  // Python 运行时
  ipcMain.handle(IPC.PYTHON_RUNTIME_LIST, () => listPythonRuntimes())
  ipcMain.handle(IPC.PYTHON_RUNTIME_DOWNLOAD, async () => downloadPortablePython())

  // ---------- 翻译 ----------
  // 发起翻译：delta 经 TRANSLATE_CHUNK_EVENT 广播，最终结果作为 invoke 返回值
  ipcMain.handle(IPC.TRANSLATE_RUN, async (_e, payload: TranslateRequestPayload) => {
    if (!payload || typeof payload.requestId !== 'string' || !payload.requestId) {
      return { ok: false, aborted: false, error: 'INVALID_REQUEST' }
    }
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      return { ok: false, aborted: false, error: 'EMPTY_TEXT' }
    }
    if (!payload.providerId || !payload.model) {
      return { ok: false, aborted: false, error: 'MISSING_CONFIG' }
    }
    // 渲染端类型已排除 auto，这里仅防异常入参
    if ((payload as { targetLang?: string }).targetLang === 'auto') {
      return { ok: false, aborted: false, error: 'INVALID_TARGET_LANG' }
    }
    return runTranslate(payload, (requestId, delta) =>
      broadcast(IPC.TRANSLATE_CHUNK_EVENT, { requestId, delta })
    )
  })
  ipcMain.handle(IPC.TRANSLATE_ABORT, (_e, requestId: string) => {
    if (typeof requestId === 'string') abortTranslate(requestId)
    return { ok: true }
  })
  ipcMain.handle(IPC.TRANSLATION_LIST, () => translationRepo.historyList())
  ipcMain.handle(IPC.TRANSLATION_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.historyDelete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.TRANSLATION_CLEAR, () => {
    translationRepo.historyClear()
    return { ok: true }
  })
  ipcMain.handle(IPC.GLOSSARY_LIST, () => translationRepo.glossaryList())
  ipcMain.handle(
    IPC.GLOSSARY_SAVE,
    (_e, input: { sourceTerm?: string; targetTerm?: string }) => {
      const sourceTerm = String(input?.sourceTerm ?? '').trim()
      const targetTerm = String(input?.targetTerm ?? '').trim()
      if (!sourceTerm || !targetTerm) throw new Error('GLOSSARY_TERM_EMPTY')
      return translationRepo.glossaryAdd({ sourceTerm, targetTerm })
    }
  )
  ipcMain.handle(IPC.GLOSSARY_DELETE, (_e, id: string) => {
    if (typeof id === 'string') translationRepo.glossaryDelete(id)
    return { ok: true }
  })

  // ---------- 绘图（图像生成） ----------
  ipcMain.handle(IPC.IMAGES_GENERATE, async (_e, payload: ImageGeneratePayload) => {
    return runImageGenerate(payload)
  })
  ipcMain.handle(IPC.IMAGES_ABORT, (_e, requestId: string) => {
    abortImageGenerate(String(requestId ?? ''))
    return { ok: true }
  })
  ipcMain.handle(IPC.IMAGES_LIST, () => listImages())
  ipcMain.handle(IPC.IMAGES_GET_FILE, (_e, id: string) => getImageFile(String(id ?? '')))
  ipcMain.handle(IPC.IMAGES_DELETE, (_e, id: string) => deleteImage(String(id ?? '')))
  ipcMain.handle(IPC.IMAGES_SAVE_AS, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return saveImageAs(win!, String(id ?? ''))
  })

  // ---------- 沙箱（v2 批次八：沙箱基础层） ----------
  ipcMain.handle(IPC.SANDBOX_LIST, () => listSandboxFiles())
  ipcMain.handle(
    IPC.SANDBOX_CREATE,
    (_e, payload: { name?: unknown; html?: unknown; opts?: unknown }) => {
      // 字段类型校验；上限/清洗在 service 内做
      if (typeof payload?.name !== 'string' || typeof payload?.html !== 'string') {
        throw new Error('参数类型错误')
      }
      const opts = payload.opts as
        | { icon?: unknown; description?: unknown; isApp?: unknown }
        | undefined
      const cleanOpts: { icon?: string; description?: string; isApp?: boolean } = {}
      if (opts?.icon !== undefined && typeof opts.icon === 'string') cleanOpts.icon = opts.icon
      if (opts?.description !== undefined && typeof opts.description === 'string')
        cleanOpts.description = opts.description
      if (opts?.isApp !== undefined) cleanOpts.isApp = !!opts.isApp
      return createSandboxFile(payload.name, payload.html, cleanOpts)
    }
  )
  ipcMain.handle(IPC.SANDBOX_GET, (_e, id: string) => getSandboxFile(String(id ?? '')))
  ipcMain.handle(IPC.SANDBOX_DELETE, (_e, id: string) => {
    deleteSandboxFile(String(id ?? ''))
    return { ok: true }
  })
  ipcMain.handle(
    IPC.SANDBOX_UPDATE_META,
    (_e, payload: { id?: unknown; patch?: unknown }) => {
      if (typeof payload?.id !== 'string' || typeof payload?.patch !== 'object' || payload.patch === null) {
        throw new Error('参数类型错误')
      }
      const p = payload.patch as Record<string, unknown>
      const patch: { name?: string; icon?: string; description?: string; isApp?: boolean } = {}
      // 字段白名单：只允许这四个字段，其余忽略
      if (p.name !== undefined && typeof p.name === 'string') patch.name = p.name
      if (p.icon !== undefined && typeof p.icon === 'string') patch.icon = p.icon
      if (p.description !== undefined && typeof p.description === 'string')
        patch.description = p.description
      if (p.isApp !== undefined) patch.isApp = !!p.isApp
      return updateSandboxMeta(payload.id, patch)
    }
  )

  // MCP 状态变化 / 日志事件 → 广播给所有窗口
  mcpManager.onStatus((evt) => broadcast(IPC.MCP_SERVER_STATUS_EVENT, evt))
  mcpManager.onLog((evt) => broadcast(IPC.MCP_SERVER_LOG_EVENT, evt))
  // Python 依赖安装（venv/pip 实时输出）→ 广播；渲染端按 serverId 自行过滤
  pythonEnvService.onInstall((evt) => broadcast(IPC.PYTHON_ENV_EVENT, evt))

  // Channels（IM Bot 网关）的 IPC handler 在下方统一注册；
  // 其事件接线与 enabled=1 自动启动需访问 DB，由 initChannelRuntime()
  // 在 boot 打开数据库之后单独调用（registerIpcHandlers 必须早于窗口创建）

  // ---------- 工具 ----------
  ipcMain.handle(IPC.TOOL_LIST_AVAILABLE, () => toolRegistry.listAll())

  // ---------- Work Agent ----------
  // AGENT_* 事件通过 chat:send 的 emit 推送到对应 sender
  // 这里仅注册一个 abort 通道
  ipcMain.handle(IPC.AGENT_ABORT, (_e, requestId: string) => {
    chatService.abort(requestId)
    return { ok: true }
  })

  // Agent 工作目录（fs_list/fs_read/fs_write 的安全边界）
  ipcMain.handle(IPC.AGENT_GET_WORKSPACE_DIR, () => getWorkspaceDir())
  ipcMain.handle(IPC.AGENT_PICK_WORKSPACE_DIR, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: '选择 Agent 工作目录 / Select Agent Workspace',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return getWorkspaceDir()
    setWorkspaceDir(result.filePaths[0])
    console.log('[agent] 工作目录已设置:', result.filePaths[0])
    return getWorkspaceDir()
  })

  // 终端命令（shell_exec）策略配置
  ipcMain.handle(IPC.AGENT_GET_SHELL_CONFIG, () => getShellConfig())
  ipcMain.handle(
    IPC.AGENT_SET_SHELL_CONFIG,
    (_e, input: { enabled?: unknown; policy?: unknown }) => {
      // 字段白名单 + 值域校验（setShellConfig 内部还会再校验一次）
      const patch: { enabled?: boolean; policy?: 'confirm' | 'auto-safe' } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.policy === 'confirm' || input?.policy === 'auto-safe') patch.policy = input.policy
      return setShellConfig(patch)
    }
  )

  // 联网搜索配置（web.search 工具；Key 明文不出主进程，渲染端只拿 hasKey）
  ipcMain.handle(IPC.AGENT_GET_WEBSEARCH_CONFIG, () => getWebSearchConfig())
  ipcMain.handle(
    IPC.AGENT_SET_WEBSEARCH_CONFIG,
    (_e, input: { enabled?: unknown; provider?: unknown; apiKey?: unknown }) => {
      const patch: { enabled?: boolean; provider?: 'tavily' | 'bocha'; apiKey?: string } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (input?.provider === 'tavily' || input?.provider === 'bocha') patch.provider = input.provider
      if (typeof input?.apiKey === 'string') patch.apiKey = input.apiKey
      return setWebSearchConfig(patch)
    }
  )

  // ---------- Channels（IM Bot 网关；Token 明文不出主进程） ----------
  ipcMain.handle(IPC.CHANNEL_GET_CONFIG, () => getChannelConfig())
  ipcMain.handle(
    IPC.CHANNEL_SET_CONFIG,
    (
      _e,
      input: {
        enabled?: unknown
        token?: unknown
        whitelist?: unknown
        assistantId?: unknown
        providerId?: unknown
        model?: unknown
        agentMode?: unknown
      }
    ) => {
      const patch: {
        enabled?: boolean
        token?: string
        whitelist?: string
        assistantId?: string
        providerId?: string
        model?: string
        agentMode?: boolean
      } = {}
      if (typeof input?.enabled === 'boolean') patch.enabled = input.enabled
      if (typeof input?.token === 'string') patch.token = input.token
      if (typeof input?.whitelist === 'string') patch.whitelist = input.whitelist
      if (typeof input?.assistantId === 'string') patch.assistantId = input.assistantId
      if (typeof input?.providerId === 'string') patch.providerId = input.providerId
      if (typeof input?.model === 'string') patch.model = input.model
      if (typeof input?.agentMode === 'boolean') patch.agentMode = input.agentMode
      return setChannelConfig(patch)
    }
  )
  ipcMain.handle(IPC.CHANNEL_START, async () => {
    try {
      await channelService.start()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle(IPC.CHANNEL_STOP, () => {
    channelService.stop()
    return { ok: true }
  })

  // 渲染端对工具审批弹窗的应答
  ipcMain.handle(
    IPC.AGENT_TOOL_APPROVE_RESPONSE,
    (_e, payload: { approvalId?: unknown; approved?: unknown }) => {
      const approvalId = String(payload?.approvalId ?? '')
      const approved = payload?.approved === true
      const matched = resolveApproval(approvalId, approved)
      return { ok: matched }
    }
  )

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
    // 用模式判断而非「是否有 key」：锁定清 key 后此字段必须仍为 true，
    // 否则锁屏 UI 会误判为无密码模式，用户无法提交密码解锁
    dbEncrypted: masterKeyManager.getMode() === 'db',
    fieldEncrypted: masterKeyManager.hasKey(),
    masterPasswordVerified: masterKeyManager.hasKey()
  }))
  ipcMain.handle(IPC.ENCRYPTION_UNLOCK, (_e, password: string) => {
    // Boot 阶段：交给 unlock coordinator
    if (unlockCoordinator.isWaiting()) {
      unlockCoordinator.submit({ password })
      return { ok: true }
    }
    // 运行时解锁（加密锁后重新打开 DB）
    const salt = appConfigRepo.getMasterPasswordSalt()
    try {
      const masterKey = masterKeyManager.setKey(password, salt ?? undefined)
      dbService.open(masterKey)
      dbService.getHandle().prepare('SELECT 1').get()
      // 关闭解锁窗口
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.getTitle().includes('解锁') || win.getTitle().includes('Unlock')) {
          win.close()
        }
      }
      // 与隐私锁状态机同步（加密锁已把 lockService 置为 locked）
      lockService.unlock()
      return { ok: true }
    } catch {
      masterKeyManager.clear()
      dbService.close()
      return { ok: false, error: '密码错误' }
    }
  })
  ipcMain.handle(IPC.ENCRYPTION_SET_MASTER_PASSWORD, (_e, password: string) => {
    unlockCoordinator.submit({ setPassword: password })
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_LOCK, () => {
    // 先进隐私锁状态机（同步触发 onStateChange → 清密钥 + 关库），
    // 使 IPC 网关与主窗口遮罩在加密锁期间同样生效
    lockService.lock('manual')
    masterKeyManager.clear()
    dbService.close()
    // 显示解锁窗口供用户重新解锁
    const unlockWin = new BrowserWindow({
      width: 420, height: 380, resizable: false, minimizable: false,
      maximizable: false, show: false, frame: true, autoHideMenuBar: true,
      title: 'PocketAI — 解锁', backgroundColor: '#1e1e2e',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false, contextIsolation: true, sandbox: true
      }
    })
    unlockWin.on('ready-to-show', () => unlockWin.show())
    denyNewWindows(unlockWin.webContents)
    if (process.env['ELECTRON_RENDERER_URL']) {
      const base = new URL(process.env['ELECTRON_RENDERER_URL'])
      base.pathname = '/unlock.html'
      base.search = '?mode=unlock'
      unlockWin.loadURL(base.toString())
    } else {
      unlockWin.loadFile(path.join(__dirname, '../renderer/unlock.html'), { query: { mode: 'unlock' } })
    }
    return { ok: true }
  })
  ipcMain.handle(IPC.ENCRYPTION_CHANGE_PASSWORD, async (_e, oldPassword: string, newPassword: string) => {
    // 密码轮换：用旧密码打开 → rekey → 更新 salt
    const salt = appConfigRepo.getMasterPasswordSalt()
    // 保存当前正确密钥，验证失败时回滚
    const currentKey = masterKeyManager.getDbKey()
    const oldKey = masterKeyManager.setKey(oldPassword, salt ?? undefined)
    // 关闭 DB 并用旧密钥重新打开，真正校验旧密码
    dbService.close()
    try {
      dbService.open(oldKey)
      dbService.getHandle().prepare('SELECT 1').get()
    } catch {
      // 旧密码错误，回滚到正确密钥
      dbService.close()
      if (currentKey) {
        masterKeyManager.setRawKey(currentKey)
        dbService.open(currentKey)
      } else {
        dbService.open()
      }
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
    // 保存当前密钥，验证失败时回滚
    const currentKey = masterKeyManager.getDbKey()
    const derivedKey = masterKeyManager.setKey(password, salt ?? undefined)
    // 关闭 DB 并用密钥重新打开，真正校验密码
    dbService.close()
    try {
      dbService.open(derivedKey)
      dbService.getHandle().prepare('SELECT 1').get()
    } catch {
      dbService.close()
      if (currentKey) {
        masterKeyManager.setRawKey(currentKey)
        dbService.open(currentKey)
      } else {
        dbService.open()
      }
      return { ok: false, error: '密码错误' }
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
    appConfigRepo.clearMasterPasswordSalt()
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
    try {
      return { ok: true as const, ...(await createEncryptedLocalBackup(dir)) }
    } catch (e) {
      // none 模式等场景：不产出固定密钥假加密包，返回可读错误由 UI 提示
      return { ok: false as const, error: (e as Error)?.message ?? '加密备份失败' }
    }
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
  ipcMain.handle(IPC.BACKUP_SCHEDULE_GET, () => getBackupSchedule())
  ipcMain.handle(
    IPC.BACKUP_SCHEDULE_SET,
    (_e, patch: { enabled?: boolean; intervalHours?: number }) =>
      setBackupSchedule(patch ?? {})
  )
  ipcMain.handle(IPC.BACKUP_WEBDAV_TEST, async (_e, cfg: any) => {
    const { testWebDAV } = await import('../backup/backup-service')
    return testWebDAV(cfg)
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_UPLOAD, async () => {
    const { loadWebDAVConfig, createWebDAVBackup } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      const r = await createWebDAVBackup(cfg)
      noteManualBackup() // 手动上传后刷新定时备份计时
      return r
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '上传失败' }
    }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_UPLOAD_INCREMENTAL, async () => {
    const { loadWebDAVConfig, createWebDAVIncrementalBackup } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    try {
      const r = await createWebDAVIncrementalBackup(cfg)
      noteManualBackup() // 手动备份同样刷新定时备份计时
      return { ok: true, ...r }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '增量备份失败' }
    }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_LIST, async () => {
    const { loadWebDAVConfig, listWebDAVBackups } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return []
    try { return await listWebDAVBackups(cfg) } catch { return [] }
  })
  ipcMain.handle(IPC.BACKUP_WEBDAV_RESTORE, async (_e, filename: string) => {
    const {
      loadWebDAVConfig,
      restoreFromWebDAV,
      restoreIncrementalFromWebDAV
    } = await import('../backup/backup-service')
    const cfg = loadWebDAVConfig()
    if (!cfg) return { ok: false, error: '未配置 WebDAV' }
    // 按文件名前缀路由：pocketai-inc-* 走增量索引恢复，其余走全量 zip 恢复
    if (filename.startsWith('pocketai-inc-')) {
      try {
        return await restoreIncrementalFromWebDAV(cfg, filename)
      } catch (e: any) {
        return { ok: false, error: e?.message ?? '增量恢复失败' }
      }
    }
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
  ipcMain.handle(IPC.LOCK_UNLOCK, (_e, password?: string) => {
    // db 模式锁定时密钥已被清除、库已被关闭（见 index.ts 锁订阅），
    // 内存比对不可用，只能用「重新派生 + 重开探针」验证密码
    if (masterKeyManager.getMode() === 'db') {
      if (!password) return { ok: false, error: '密码错误' }
      const salt = appConfigRepo.getMasterPasswordSalt()
      try {
        const key = masterKeyManager.setKey(password, salt ?? undefined)
        dbService.open(key)
        dbService.getHandle().prepare('SELECT 1').get()
      } catch {
        masterKeyManager.clear()
        dbService.close()
        return { ok: false, error: '密码错误' }
      }
    }
    lockService.unlock()
    return { ok: true }
  })
  ipcMain.handle(IPC.LOCK_SET_AUTO_TIMEOUT, (_e, timeoutMs: number) => {
    lockService.setAutoTimeout(timeoutMs)
    return { ok: true }
  })
  ipcMain.handle(IPC.LOCK_MARK_ACTIVE, () => {
    lockService.markActive()
    return { ok: true }
  })
  // 锁屏状态变化 → 广播
  lockService.onStateChange((evt) => broadcast(IPC.LOCK_STATE_EVENT, evt))

  // ---------- 平台管家 ----------
  ipcMain.handle(IPC.HEALTH_REPORT, () => healthService.report())
  ipcMain.handle(IPC.HEALTH_CLEANUP, () => healthService.cleanup())
  ipcMain.handle(IPC.HEALTH_VACUUM, () => healthService.vacuum())
  ipcMain.handle(IPC.STEWARD_MODEL_RECOMMEND, async () => {
    try {
      return { ok: true, data: await recommendModels() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.STEWARD_AUDIT, () => {
    try {
      return { ok: true, data: runAudit() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.STEWARD_DIAGNOSE, () => {
    try {
      return { ok: true, data: runDiagnose() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---------- 界面偏好（透明度 / 自定义 CSS） ----------
  ipcMain.handle(IPC.UI_GET_PREFS, () => {
    try {
      return { ok: true, data: getUiPreferences() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.UI_SET_PREFS, (_e, patch: Partial<UiPreferences>) => {
    try {
      return { ok: true, data: setUiPreferences(patch ?? {}) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // ---------- 侧栏模块顺序 ----------
  const K_SIDEBAR_ORDER = 'sidebar.order'

  /** 读取侧栏顺序；配置缺失或非法时回退默认值 */
  function readSidebarOrder(): SidebarModuleId[] {
    const raw = appConfigRepo.get(K_SIDEBAR_ORDER)
    if (raw) {
      try {
        const arr = JSON.parse(raw)
        if (
          Array.isArray(arr) &&
          arr.length === DEFAULT_SIDEBAR_ORDER.length &&
          new Set(arr).size === DEFAULT_SIDEBAR_ORDER.length &&
          DEFAULT_SIDEBAR_ORDER.every((m) => arr.includes(m))
        ) {
          return arr as SidebarModuleId[]
        }
      } catch {
        /* 解析失败 → 回退默认 */
      }
    }
    return [...DEFAULT_SIDEBAR_ORDER]
  }

  ipcMain.handle(IPC.SIDEBAR_GET_ORDER, () => {
    try {
      return { ok: true, data: readSidebarOrder() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle(IPC.SIDEBAR_SET_ORDER, (_e, order: SidebarModuleId[]) => {
    try {
      // 必须是全部模块的一个排列，否则拒绝
      const valid =
        Array.isArray(order) &&
        order.length === DEFAULT_SIDEBAR_ORDER.length &&
        new Set(order).size === DEFAULT_SIDEBAR_ORDER.length &&
        DEFAULT_SIDEBAR_ORDER.every((m) => order.includes(m))
      if (!valid) return { ok: false, error: 'invalid order' }
      appConfigRepo.set(K_SIDEBAR_ORDER, JSON.stringify(order))
      return { ok: true, data: order }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

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

/**
 * Channels 运行时接线：必须在数据库打开后调用。
 * registerIpcHandlers() 只做通道注册（窗口创建前），
 * autoStart() 会读取 app_config，DB 未就绪时调用会抛 “Database not opened”。
 */
export function initChannelRuntime(): void {
  channelService.init()
  channelService.onStatus((evt) => broadcast(IPC.CHANNEL_STATUS_EVENT, evt))
  void channelService.autoStart()
}
