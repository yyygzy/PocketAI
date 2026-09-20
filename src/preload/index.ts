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
  RegeneratePayload,
  ResendPayload,
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
  PythonEnvState,
  PythonEnvInstallEvent,
  PythonPipSource,
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
  ModelRecommendation,
  AuditResult,
  DiagnoseResult,
  BackupScheduleStatus,
  UiPreferences,
  FileEntry,
  FileReadResult,
  FileOpResult,
  Note,
  PythonRuntime,
  HardwareInfo,
  TranslateRequestPayload,
  TranslateChunkEvent,
  TranslationRecord,
  GlossaryTerm,
  ShellConfig,
  ToolApprovalRequestEvent,
  WebSearchConfig,
  ChannelConfig,
  ChannelStatusEvent,
  SandboxFileMeta,
  ImageGeneratePayload,
  ImageResult,
  ImageListItem
} from '../shared/types'

const api = {
  // ---------- 系统 ----------
  getHardwareInfo: (force?: boolean): Promise<HardwareInfo> =>
    ipcRenderer.invoke(IPC.SYSTEM_HARDWARE_INFO, force),
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
  deleteSkill: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.SKILL_DELETE, id),
  exportSkill: (
    id: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SKILL_EXPORT, id),
  importSkill: (): Promise<{
    ok: boolean
    canceled?: boolean
    skill?: SkillRecord
    error?: string
  }> => ipcRenderer.invoke(IPC.SKILL_IMPORT),

  // ---------- 会话 ----------
  listConversations: (assistantId?: string, isAgent?: boolean): Promise<ConversationRecord[]> =>
    ipcRenderer.invoke(IPC.CONVERSATION_LIST, assistantId, isAgent),
  createConversation: (assistantId?: string | null, title?: string): Promise<ConversationRecord> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, assistantId, title),
  deleteConversation: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),
  renameConversation: (id: string, title: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_RENAME, id, title),
  exportConversation: (id: string): Promise<{ ok: boolean; data?: any; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT, id),
  importConversation: (payload: any): Promise<{ ok: boolean; conversationId?: string; messageCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_IMPORT, payload),
  forkConversation: (conversationId: string, messageId: string): Promise<{ ok: boolean; conversation?: ConversationRecord; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_FORK, conversationId, messageId),

  // ---------- 消息 ----------
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_LIST, conversationId),
  deleteMessage: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MESSAGE_DELETE, id),
  searchMessages: (query: string): Promise<any[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_SEARCH, query),

  // ---------- 聊天 ----------
  sendMessage: (payload: SendMessagePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_SEND, payload),
  regenerateMessage: (payload: RegeneratePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_REGENERATE, payload),
  resendMessage: (payload: ResendPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.CHAT_RESEND, payload),
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
  deleteMcpServer: (
    id: string
  ): Promise<{ ok: boolean; warning?: string; error?: string }> =>
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

  // ---------- Python MCP 依赖环境 ----------
  installPythonEnv: (
    serverId: string
  ): Promise<{ ok: boolean; state?: PythonEnvState; error?: string }> =>
    ipcRenderer.invoke(IPC.PYTHON_ENV_INSTALL, serverId),
  getPythonEnvStatus: (
    serverId: string
  ): Promise<{
    ok: boolean
    state?: PythonEnvState
    recentEvents?: PythonEnvInstallEvent[]
    error?: string
  }> => ipcRenderer.invoke(IPC.PYTHON_ENV_STATUS, serverId),
  getPythonPipSource: (): Promise<{ ok: boolean; source?: PythonPipSource; error?: string }> =>
    ipcRenderer.invoke(IPC.PYTHON_PIP_SOURCE_GET),
  setPythonPipSource: (
    source: PythonPipSource
  ): Promise<{ ok: boolean; source?: PythonPipSource; error?: string }> =>
    ipcRenderer.invoke(IPC.PYTHON_PIP_SOURCE_SET, source),
  onPythonEnvEvent: (handler: (e: PythonEnvInstallEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: PythonEnvInstallEvent) => handler(data)
    ipcRenderer.on(IPC.PYTHON_ENV_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.PYTHON_ENV_EVENT, listener)
  },

  // ---------- 笔记 ----------
  listNotes: (): Promise<Note[]> => ipcRenderer.invoke(IPC.NOTES_LIST),
  getNote: (id: string): Promise<Note | null> => ipcRenderer.invoke(IPC.NOTES_GET, id),
  createNote: (input: {
    title?: string
    content?: string
    tags?: string[]
  }): Promise<Note> => ipcRenderer.invoke(IPC.NOTES_CREATE, input),
  updateNote: (
    id: string,
    patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>> & { tags?: string[] }
  ): Promise<Note | null> => ipcRenderer.invoke(IPC.NOTES_UPDATE, id, patch),
  deleteNote: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.NOTES_DELETE, id),
  searchNotes: (keyword: string): Promise<Note[]> => ipcRenderer.invoke(IPC.NOTES_SEARCH, keyword),
  createNoteFromMessage: (input: {
    title?: string
    content: string
  }): Promise<Note> => ipcRenderer.invoke(IPC.NOTES_CREATE_FROM_MESSAGE, input),

  // ---------- Python 运行时 ----------
  listPythonRuntimes: (): Promise<PythonRuntime[]> => ipcRenderer.invoke(IPC.PYTHON_RUNTIME_LIST),
  downloadPortablePython: (): Promise<PythonRuntime> => ipcRenderer.invoke(IPC.PYTHON_RUNTIME_DOWNLOAD),

  // ---------- 翻译 ----------
  translate: (
    payload: TranslateRequestPayload
  ): Promise<{ ok: true; content: string } | { ok: false; aborted: boolean; error: string }> =>
    ipcRenderer.invoke(IPC.TRANSLATE_RUN, payload),
  abortTranslate: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.TRANSLATE_ABORT, requestId),
  onTranslateChunk: (handler: (e: TranslateChunkEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: TranslateChunkEvent) => handler(data)
    ipcRenderer.on(IPC.TRANSLATE_CHUNK_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.TRANSLATE_CHUNK_EVENT, listener)
  },
  listTranslations: (): Promise<TranslationRecord[]> => ipcRenderer.invoke(IPC.TRANSLATION_LIST),
  deleteTranslation: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.TRANSLATION_DELETE, id),
  clearTranslations: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.TRANSLATION_CLEAR),
  listGlossary: (): Promise<GlossaryTerm[]> => ipcRenderer.invoke(IPC.GLOSSARY_LIST),
  saveGlossaryTerm: (input: {
    sourceTerm: string
    targetTerm: string
  }): Promise<GlossaryTerm> => ipcRenderer.invoke(IPC.GLOSSARY_SAVE, input),
  deleteGlossaryTerm: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.GLOSSARY_DELETE, id),

  // ---------- 绘图（图像生成） ----------
  generateImage: (payload: ImageGeneratePayload): Promise<ImageResult> =>
    ipcRenderer.invoke(IPC.IMAGES_GENERATE, payload),
  abortImage: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.IMAGES_ABORT, requestId),
  listImages: (): Promise<ImageListItem[]> => ipcRenderer.invoke(IPC.IMAGES_LIST),
  getImageFile: (id: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.IMAGES_GET_FILE, id),
  deleteImage: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.IMAGES_DELETE, id),
  saveImageAs: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.IMAGES_SAVE_AS, id),

  // ---------- 工具 ----------
  listAvailableTools: (): Promise<ToolSchema[]> => ipcRenderer.invoke(IPC.TOOL_LIST_AVAILABLE),

  // ---------- Work Agent ----------
  abortAgent: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.AGENT_ABORT, requestId),
  getAgentWorkspaceDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_GET_WORKSPACE_DIR),
  pickAgentWorkspaceDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC.AGENT_PICK_WORKSPACE_DIR),
  getShellConfig: (): Promise<ShellConfig> =>
    ipcRenderer.invoke(IPC.AGENT_GET_SHELL_CONFIG),
  setShellConfig: (patch: Partial<ShellConfig>): Promise<ShellConfig> =>
    ipcRenderer.invoke(IPC.AGENT_SET_SHELL_CONFIG, patch),

  // ---------- 联网搜索配置（web.search；Key 明文不出主进程） ----------
  getWebSearchConfig: (): Promise<WebSearchConfig> =>
    ipcRenderer.invoke(IPC.AGENT_GET_WEBSEARCH_CONFIG),
  setWebSearchConfig: (
    patch: Partial<Pick<WebSearchConfig, 'enabled' | 'provider' | 'apiKey'>>
  ): Promise<WebSearchConfig> => ipcRenderer.invoke(IPC.AGENT_SET_WEBSEARCH_CONFIG, patch),

  /** 订阅工具审批请求（全局弹窗）；返回退订函数 */
  onToolApprovalRequest: (
    handler: (e: ToolApprovalRequestEvent) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ToolApprovalRequestEvent) => handler(data)
    ipcRenderer.on(IPC.AGENT_TOOL_APPROVAL_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_TOOL_APPROVAL_EVENT, listener)
  },
  /** 应答工具审批弹窗 */
  respondToolApproval: (
    approvalId: string,
    approved: boolean
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.AGENT_TOOL_APPROVE_RESPONSE, { approvalId, approved }),

  // ---------- Channels（IM Bot 网关；Token 明文不出主进程） ----------
  getChannelConfig: (): Promise<ChannelConfig> =>
    ipcRenderer.invoke(IPC.CHANNEL_GET_CONFIG),
  setChannelConfig: (
    patch: Partial<
      Pick<
        ChannelConfig,
        'enabled' | 'token' | 'whitelist' | 'assistantId' | 'providerId' | 'model' | 'agentMode'
      >
    >
  ): Promise<ChannelConfig> => ipcRenderer.invoke(IPC.CHANNEL_SET_CONFIG, patch),
  startChannel: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CHANNEL_START),
  stopChannel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.CHANNEL_STOP),
  /** 订阅网关状态变化；返回退订函数 */
  onChannelStatus: (handler: (e: ChannelStatusEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChannelStatusEvent) => handler(data)
    ipcRenderer.on(IPC.CHANNEL_STATUS_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHANNEL_STATUS_EVENT, listener)
  },

  // ---------- 沙箱（v2 批次八：沙箱基础层） ----------
  listSandboxFiles: (): Promise<SandboxFileMeta[]> =>
    ipcRenderer.invoke(IPC.SANDBOX_LIST),
  createSandboxFile: (
    name: string,
    html: string,
    opts?: { icon?: string; description?: string; isApp?: boolean }
  ): Promise<SandboxFileMeta> =>
    ipcRenderer.invoke(IPC.SANDBOX_CREATE, { name, html, opts }),
  getSandboxFile: (id: string): Promise<{ meta: SandboxFileMeta; html: string } | null> =>
    ipcRenderer.invoke(IPC.SANDBOX_GET, id),
  deleteSandboxFile: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.SANDBOX_DELETE, id),
  updateSandboxMeta: (
    id: string,
    patch: { name?: string; icon?: string; description?: string; isApp?: boolean }
  ): Promise<SandboxFileMeta | null> =>
    ipcRenderer.invoke(IPC.SANDBOX_UPDATE_META, { id, patch }),

  // ---------- 快捷浮窗（快捷问答 / 选区助手） ----------
  hidePopup: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.POPUP_HIDE),
  getPopupPayload: (): Promise<import('../shared/types').PopupPayload | null> =>
    ipcRenderer.invoke(IPC.POPUP_GET_PAYLOAD),
  getPopupConfig: (): Promise<import('../shared/types').PopupConfig> =>
    ipcRenderer.invoke(IPC.POPUP_GET_CONFIG),
  setPopupConfig: (
    patch: Partial<import('../shared/types').PopupConfig>
  ): Promise<import('../shared/types').PopupSetConfigResult> =>
    ipcRenderer.invoke(IPC.POPUP_SET_CONFIG, patch),

  // ---------- 界面偏好 ----------
  getUiPrefs: (): Promise<{ ok: boolean; data?: UiPreferences; error?: string }> =>
    ipcRenderer.invoke(IPC.UI_GET_PREFS),
  setUiPrefs: (
    patch: Partial<UiPreferences>
  ): Promise<{ ok: boolean; data?: UiPreferences; error?: string }> =>
    ipcRenderer.invoke(IPC.UI_SET_PREFS, patch),

  // ---------- 侧栏模块顺序 ----------
  getSidebarOrder: (): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_GET_ORDER),
  setSidebarOrder: (
    order: import('../shared/types').SidebarModuleId[]
  ): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_SET_ORDER, order),
  onPopupPayload: (handler: (e: import('../shared/types').PopupPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: import('../shared/types').PopupPayload) =>
      handler(data)
    ipcRenderer.on(IPC.POPUP_PAYLOAD_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.POPUP_PAYLOAD_EVENT, listener)
  },

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
  createEncryptedLocalBackup: (): Promise<
    { ok: true; path: string; size: number; encrypted: boolean; saltB64: string }
    | { ok: false; error: string }
  > =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL_ENCRYPTED),
  saveWebDAVConfig: (cfg: any): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg),
  loadWebDAVConfig: (): Promise<any | null> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LOAD_CONFIG),
  testWebDAV: (cfg: any): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_TEST, cfg),
  uploadWebDAVBackup: (): Promise<{ ok?: boolean; filename?: string; size?: number; encrypted?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_UPLOAD),
  uploadIncrementalBackup: (): Promise<
    import('../shared/types').IncrementalBackupResult & { ok?: boolean; error?: string }
  > => ipcRenderer.invoke(IPC.BACKUP_WEBDAV_UPLOAD_INCREMENTAL),
  listWebDAVBackups: (): Promise<any[]> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LIST),
  restoreWebDAVBackup: (filename: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_RESTORE, filename),
  deleteWebDAVBackup: (filename: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_DELETE, filename),
  getBackupSchedule: (): Promise<BackupScheduleStatus> =>
    ipcRenderer.invoke(IPC.BACKUP_SCHEDULE_GET),
  setBackupSchedule: (
    patch: { enabled?: boolean; intervalHours?: number }
  ): Promise<BackupScheduleStatus> =>
    ipcRenderer.invoke(IPC.BACKUP_SCHEDULE_SET, patch),

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
  unlock: (password?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.LOCK_UNLOCK, password),
  setAutoLockTimeout: (timeoutMs: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_SET_AUTO_TIMEOUT, timeoutMs),
  markActive: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_MARK_ACTIVE),
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
  recommendModels: (): Promise<{ ok: boolean; data?: ModelRecommendation; error?: string }> =>
    ipcRenderer.invoke(IPC.STEWARD_MODEL_RECOMMEND),
  runAudit: (): Promise<{ ok: boolean; data?: AuditResult; error?: string }> =>
    ipcRenderer.invoke(IPC.STEWARD_AUDIT),
  runDiagnose: (): Promise<{ ok: boolean; data?: DiagnoseResult; error?: string }> =>
    ipcRenderer.invoke(IPC.STEWARD_DIAGNOSE),

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
