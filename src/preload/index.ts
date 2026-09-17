// preload：安全桥，只暴露白名单 API
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type {
  ProviderRecord,
  AssistantRecord,
  SkillRecord,
  ConversationRecord,
  MessageRecord,
  SendMessagePayload,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  KnowledgeBase,
  KbDocument,
  KbChunk,
  RetrievalResult,
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent,
  McpServerLogEvent,
  AgentStepEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  ToolSchema,
  LicenseStatus,
  EncryptionStatus,
  LockStatus,
  LockStateEvent,
  HealthReport,
  CleanupResult,
  FileEntry,
  FileReadResult,
  FileOpResult
} from '../shared/types'

const api = {
  // ---------- 系统 ----------
  getHardwareInfo: () => ipcRenderer.invoke(IPC.SYSTEM_HARDWARE_INFO),
  getPaths: () => ipcRenderer.invoke(IPC.APP_GET_PATHS),
  setAppLanguage: (lang: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MENU_SET_LANGUAGE, lang),
  runMigrations: () => ipcRenderer.invoke(IPC.DB_RUN_MIGRATIONS),
  checkIntegrity: () => ipcRenderer.invoke(IPC.DB_INTEGRITY_CHECK),

  // ---------- Provider ----------
  listProviders: (): Promise<ProviderRecord[]> =>
    ipcRenderer.invoke(IPC.PROVIDER_LIST),
  saveProvider: (record: ProviderRecord): Promise<ProviderRecord> =>
    ipcRenderer.invoke(IPC.PROVIDER_SAVE, record),
  deleteProvider: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.PROVIDER_DELETE, id),
  fetchModels: (id: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.PROVIDER_FETCH_MODELS, id),
  testProvider: (
    id: string
  ): Promise<{ ok: boolean; modelCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.PROVIDER_TEST, id),

  // ---------- 助手 ----------
  listAssistants: (): Promise<AssistantRecord[]> =>
    ipcRenderer.invoke(IPC.ASSISTANT_LIST),
  getAssistant: (id: string): Promise<AssistantRecord | null> =>
    ipcRenderer.invoke(IPC.ASSISTANT_GET, id),
  saveAssistant: (
    record: Partial<AssistantRecord> & { name: string }
  ): Promise<AssistantRecord> => ipcRenderer.invoke(IPC.ASSISTANT_SAVE, record),
  deleteAssistant: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ASSISTANT_DELETE, id),
  duplicateAssistant: (id: string): Promise<AssistantRecord> =>
    ipcRenderer.invoke(IPC.ASSISTANT_DUPLICATE, id),
  setAssistantPinned: (id: string, pinned: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ASSISTANT_SET_PINNED, id, pinned),

  // ---------- 技能 ----------
  listSkills: (): Promise<SkillRecord[]> => ipcRenderer.invoke(IPC.SKILL_LIST),
  getSkill: (id: string): Promise<SkillRecord | null> =>
    ipcRenderer.invoke(IPC.SKILL_GET, id),
  saveSkill: (record: Partial<SkillRecord> & { name: string }): Promise<SkillRecord> =>
    ipcRenderer.invoke(IPC.SKILL_SAVE, record),
  deleteSkill: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.SKILL_DELETE, id),

  // ---------- 会话 ----------
  listConversations: (assistantId?: string): Promise<ConversationRecord[]> =>
    ipcRenderer.invoke(IPC.CONVERSATION_LIST, assistantId),
  createConversation: (assistantId?: string | null): Promise<ConversationRecord> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, assistantId),
  deleteConversation: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),
  renameConversation: (id: string, title: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_RENAME, id, title),
  exportConversation: (id: string): Promise<{ ok: boolean; data?: any; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT, id),
  importConversation: (payload: any): Promise<{ ok: boolean; conversationId?: string; messageCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_IMPORT, payload),

  // ---------- 消息 ----------
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_LIST, conversationId),
  searchMessages: (query: string): Promise<any[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_SEARCH, query),

  // ---------- 聊天 ----------
  sendMessage: (payload: SendMessagePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_SEND, payload),
  abortChat: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CHAT_ABORT, requestId),

  onChatChunk: (handler: (e: ChatChunkEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatChunkEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_CHUNK_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_CHUNK_EVENT, listener)
  },
  onChatDone: (handler: (e: ChatDoneEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatDoneEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_DONE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_DONE_EVENT, listener)
  },
  onChatError: (handler: (e: ChatErrorEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChatErrorEvent) => handler(data)
    ipcRenderer.on(IPC.CHAT_ERROR_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHAT_ERROR_EVENT, listener)
  },

  // ---------- 知识库 ----------
  listKnowledgeBases: (): Promise<KnowledgeBase[]> => ipcRenderer.invoke(IPC.KB_LIST),
  getKnowledgeBase: (id: string): Promise<KnowledgeBase | null> =>
    ipcRenderer.invoke(IPC.KB_GET, id),
  saveKnowledgeBase: (
    record: Partial<KnowledgeBase> & { name: string }
  ): Promise<KnowledgeBase> => ipcRenderer.invoke(IPC.KB_SAVE, record),
  deleteKnowledgeBase: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_DELETE, id),

  listKbDocuments: (kbId: string): Promise<KbDocument[]> =>
    ipcRenderer.invoke(IPC.KB_DOC_LIST, kbId),
  addKbFiles: (kbId: string): Promise<KbDocument[]> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_FILE, kbId),
  addKbUrl: (kbId: string, url: string, title?: string): Promise<KbDocument | null> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_URL, kbId, url, title),
  addKbText: (kbId: string, text: string, title: string): Promise<KbDocument | null> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_TEXT, kbId, text, title),
  deleteKbDocument: (docId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_DOC_DELETE, docId),
  reindexKbDocument: (kbId: string, docId: string): Promise<KbDocument | null> =>
    ipcRenderer.invoke(IPC.KB_DOC_REINDEX, kbId, docId),

  listKbChunks: (docId: string): Promise<KbChunk[]> =>
    ipcRenderer.invoke(IPC.KB_CHUNK_LIST, docId),
  retrieveKb: (kbIds: string[], query: string): Promise<RetrievalResult> =>
    ipcRenderer.invoke(IPC.KB_RETRIEVE, kbIds, query),

  // ---------- MCP Server ----------
  listMcpServers: (): Promise<McpServerRecord[]> => ipcRenderer.invoke(IPC.MCP_SERVER_LIST),
  getMcpServer: (id: string): Promise<McpServerRecord | null> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_GET, id),
  saveMcpServer: (
    record: Partial<McpServerRecord> & { name: string }
  ): Promise<McpServerRecord> => ipcRenderer.invoke(IPC.MCP_SERVER_SAVE, record),
  deleteMcpServer: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_DELETE, id),
  startMcpServer: (
    id: string
  ): Promise<{ ok: boolean; runtime?: McpServerRuntime; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_START, id),
  stopMcpServer: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_STOP, id),
  restartMcpServer: (
    id: string
  ): Promise<{ ok: boolean; runtime?: McpServerRuntime; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_RESTART, id),
  listMcpServerTools: (
    id: string
  ): Promise<{ ok: boolean; tools?: ToolSchema[]; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_LIST_TOOLS, id),
  getMcpRuntimes: (): Promise<McpServerRuntime[]> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_GET_RUNTIMES),

  onMcpStatus: (handler: (e: McpServerStatusEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: McpServerStatusEvent) => handler(data)
    ipcRenderer.on(IPC.MCP_SERVER_STATUS_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.MCP_SERVER_STATUS_EVENT, listener)
  },
  onMcpLog: (handler: (e: McpServerLogEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: McpServerLogEvent) => handler(data)
    ipcRenderer.on(IPC.MCP_SERVER_LOG_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.MCP_SERVER_LOG_EVENT, listener)
  },

  // ---------- 工具 ----------
  listAvailableTools: (): Promise<ToolSchema[]> => ipcRenderer.invoke(IPC.TOOL_LIST_AVAILABLE),

  // ---------- Work Agent ----------
  abortAgent: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.AGENT_ABORT, requestId),
  getAgentWorkspaceDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_GET_WORKSPACE_DIR),
  pickAgentWorkspaceDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_PICK_WORKSPACE_DIR),

  onAgentStep: (handler: (e: AgentStepEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: AgentStepEvent) => handler(data)
    ipcRenderer.on(IPC.AGENT_STEP_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_STEP_EVENT, listener)
  },
  onAgentChunk: (
    handler: (e: {
      requestId: string
      conversationId: string
      stepIndex: number
      messageId: string
      delta: string
    }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: any) => handler(data)
    ipcRenderer.on(IPC.AGENT_CHUNK_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_CHUNK_EVENT, listener)
  },
  onAgentDone: (handler: (e: AgentDoneEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: AgentDoneEvent) => handler(data)
    ipcRenderer.on(IPC.AGENT_DONE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_DONE_EVENT, listener)
  },
  onAgentError: (handler: (e: AgentErrorEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: AgentErrorEvent) => handler(data)
    ipcRenderer.on(IPC.AGENT_ERROR_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_ERROR_EVENT, listener)
  },

  // ---------- License 授权 ----------
  getLicenseStatus: (): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC.LICENSE_GET_STATUS),
  loadLicenseFile: (filePath: string): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC.LICENSE_LOAD_FILE, filePath),
  loadLicenseString: (content: string): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC.LICENSE_LOAD_STRING, content),
  clearLicense: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LICENSE_CLEAR),
  licenseHasFeature: (feature: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.LICENSE_HAS_FEATURE, feature),

  // ---------- 加密 ----------
  getEncryptionStatus: (): Promise<EncryptionStatus> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_GET_STATUS),
  unlockEncryption: (password: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_UNLOCK, password),
  lockEncryption: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_LOCK),
  setMasterPassword: (password: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_SET_MASTER_PASSWORD, password),
  changePassword: (oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_CHANGE_PASSWORD, oldPassword, newPassword),
  disableEncryption: (password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_DISABLE, password),
  enableEncryption: (password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_ENABLE, password),

  // ---------- 备份 ----------
  createLocalBackup: (): Promise<{ path: string; size: number; encrypted: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL),
  createEncryptedLocalBackup: (): Promise<{ path: string; size: number; encrypted: boolean; saltB64: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL_ENCRYPTED),
  saveWebDAVConfig: (cfg: any): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg),
  loadWebDAVConfig: (): Promise<any | null> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LOAD_CONFIG),
  testWebDAV: (cfg: any): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_TEST, cfg),
  uploadWebDAVBackup: (): Promise<{ ok?: boolean; filename?: string; size?: number; encrypted?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_UPLOAD),
  listWebDAVBackups: (): Promise<any[]> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LIST),
  restoreWebDAVBackup: (filename: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_RESTORE, filename),
  deleteWebDAVBackup: (filename: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_DELETE, filename),

  // ---------- 自动更新 ----------
  getUpdateInfo: (): Promise<any> =>
    ipcRenderer.invoke(IPC.UPDATE_GET_INFO),
  checkUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK),
  downloadUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  quitAndInstall: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_QUIT_INSTALL),
  setAutoUpdate: (enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_SET_SETTINGS, enabled),
  onUpdateEvent: (callback: (e: any) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on(IPC.UPDATE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.UPDATE_EVENT, listener)
  },

  // ---------- 隐私锁 ----------
  getLockStatus: (): Promise<LockStatus> =>
    ipcRenderer.invoke(IPC.LOCK_GET_STATUS),
  lock: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_LOCK),
  unlock: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_UNLOCK),
  setAutoLockTimeout: (timeoutMs: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_SET_AUTO_TIMEOUT, timeoutMs),
  onLockStateChange: (handler: (e: LockStateEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: LockStateEvent) => handler(data)
    ipcRenderer.on(IPC.LOCK_STATE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.LOCK_STATE_EVENT, listener)
  },

  // ---------- 平台管家 ----------
  getHealthReport: (): Promise<HealthReport> =>
    ipcRenderer.invoke(IPC.HEALTH_REPORT),
  runCleanup: (): Promise<CleanupResult> =>
    ipcRenderer.invoke(IPC.HEALTH_CLEANUP),
  runVacuum: (): Promise<number> =>
    ipcRenderer.invoke(IPC.HEALTH_VACUUM),

  // ---------- 文件模块 ----------
  listFiles: (relDir: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke(IPC.FILE_LIST, relDir),
  readFile: (relPath: string): Promise<FileReadResult> =>
    ipcRenderer.invoke(IPC.FILE_READ, relPath),
  uploadFile: (relDir: string, name: string, base64: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_UPLOAD, relDir, name, base64),
  mkdir: (relDir: string, name: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_MKDIR, relDir, name),
  deleteFile: (relPath: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_DELETE, relPath),
  saveFileAs: (relPath: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_SAVE_AS, relPath),
  openFileLocation: (relPath: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_OPEN_LOCATION, relPath),
  openFileExternal: (relPath: string): Promise<FileOpResult> =>
    ipcRenderer.invoke(IPC.FILE_OPEN_EXTERNAL, relPath)
}

contextBridge.exposeInMainWorld('pocketai', api)

export type PocketAPI = typeof api
