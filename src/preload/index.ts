// preload：安全桥，只暴露白名单 API
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type { LocalJudgementReport } from '../shared/local-judgement'
import type { KbEvalRunResult } from '../shared/kb-eval'
import type {
  AgentEvalProgressEvent,
  AgentEvalReportEntry,
  AgentEvalRunResult
} from '../shared/agent-eval'
import type { DelegateCapabilityView, DelegateFailure, DelegateProbeResult } from '../shared/delegate-capability'
import type {
  ProviderRecord,
  AssistantRecord,
  SkillRecord,
  UserMemoryRecord,
  ConversationRecord,
  MessageRecord,
  StarredMessageItem,
  ConversationExportPayload,
  ConversationExternalImportResult,
  MessageSearchResult,
  McpCallLogRecord,
  UsageSummary,
  UsageConversationItem,
  UsageAssistantItem,
  UsagePricing,
  UsageModelItem,
  UsageDetailResult,
  DataHealthReport,
  SendMessagePayload,
  RegeneratePayload,
  ResendPayload,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  ConversationTitleEvent,
  MessageSource,
  KbAskChunkEvent,
  KbAskDoneEvent,
  KbAskErrorEvent,
  KbAskSessionMeta,
  KbAskRoamItem,
  KbAskRetention,
  KbAskSessionRecord,
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
  AgentChunkEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentRunStats,
  AgentSessionStats,
  AgentTraceRecord,
  ToolSchema,
  LicenseStatus,
  ActivationResult,
  UpdateInfo,
  UpdateEvent,
  WebDAVConfig,
  WebDAVBackupFile,
  EncryptionStatus,
  AuthResult,
  AuthLockState,
  LockStatus,
  LockStateEvent,
  ReminderFiredPayload,
  ReminderCreatePayload,
  ReminderRecord,
  OllamaRuntimeStatus,
  OllamaInstallEvent,
  OllamaPullEvent,
  HealthReport,
  CleanupResult,
  ModelRecommendation,
  AuditResult,
  DiagnoseResult,
  WizardState,
  BackupScheduleStatus,
  UiPreferences,
  FileEntry,
  FileReadResult,
  FileOpResult,
  Note,
  PromptSnippetRecord,
  PythonRuntime,
  HardwareInfo,
  TranslateRequestPayload,
  TranslateChunkEvent,
  TranslationRecord,
  GlossaryTerm,
  ShellConfig,
  ToolApprovalRequestEvent,
  WebSearchConfig,
  CalendarConfig,
  ChannelConfig,
  ChannelStatusEvent,
  ChannelType,
  SandboxFileMeta,
  ImageGeneratePayload,
  ImageResult,
  ImageListItem
} from '../shared/types'

const api = {
  // ---------- 系统 ----------
  // §258：这三发原来标成裸值（`Promise<HardwareInfo>` 等），可 safeHandle 失败时送来的是 `{ok:false,error}`
  // ⇒ 失败对象过得了类型、过得了 `if (hw)`。改成信封后调用点必须判（同 :1210 的 recommendModels 口径）。
  getHardwareInfo: (force?: boolean): Promise<{ ok: boolean; data?: HardwareInfo; error?: string }> =>
    ipcRenderer.invoke(IPC.SYSTEM_HARDWARE_INFO, force),
  getPaths: () => ipcRenderer.invoke(IPC.APP_GET_PATHS),
  setAppLanguage: (lang: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MENU_SET_LANGUAGE, lang),
  runMigrations: () => ipcRenderer.invoke(IPC.DB_RUN_MIGRATIONS),
  // `data` 才是库完整性结论（`{ok,details}`），外层 `ok` 只说"这一发读到了吗"
  checkIntegrity: (): Promise<{ ok: boolean; data?: { ok: boolean; details: string }; error?: string }> =>
    ipcRenderer.invoke(IPC.DB_INTEGRITY_CHECK),

  // ---------- Provider ----------
  listProviders: (): Promise<ProviderRecord[]> =>
    ipcRenderer.invoke(IPC.PROVIDER_LIST),
  saveProvider: (record: ProviderRecord): Promise<ProviderRecord | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.PROVIDER_SAVE, record),
  /** 按需揭示单个 Provider 的真实密钥（listProviders 为掩码视图） */
  revealProviderKeys: (id: string): Promise<{ ok: boolean; apiKeys: string[] }> =>
    ipcRenderer.invoke(IPC.PROVIDER_REVEAL_KEYS, id),
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
  ): Promise<AssistantRecord | { ok: false; error: string }> => ipcRenderer.invoke(IPC.ASSISTANT_SAVE, record),
  deleteAssistant: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ASSISTANT_DELETE, id),
  duplicateAssistant: (id: string, displayName?: string): Promise<AssistantRecord> =>
    ipcRenderer.invoke(IPC.ASSISTANT_DUPLICATE, id, displayName),
  setAssistantPinned: (id: string, pinned: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ASSISTANT_SET_PINNED, id, pinned),
  exportAssistants: (): Promise<
    { ok: true; canceled: true } | { ok: true; path: string; count: number } | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.ASSISTANT_EXPORT),
  importAssistants: (opts?: {
    confirmToken?: string
  }): Promise<
    | { ok: true; canceled: true }
    /** 存在同名覆盖：未写入任何数据，需用 confirmToken 再调一次才会覆盖 */
    | { ok: true; needsConfirm: true; conflicts: string[]; confirmToken: string; skipped: number; droppedTools: number }
    | { ok: true; imported: number; overwritten: number; skipped: number; droppedKb: number; droppedSkills: number; droppedTools: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.ASSISTANT_IMPORT, opts),

  // ---------- 用户记忆 ----------
  listMemories: (): Promise<UserMemoryRecord[]> => ipcRenderer.invoke(IPC.MEMORY_LIST),
  addMemory: (content: string): Promise<UserMemoryRecord> =>
    ipcRenderer.invoke(IPC.MEMORY_ADD, content),
  updateMemory: (id: string, content: string): Promise<UserMemoryRecord> =>
    ipcRenderer.invoke(IPC.MEMORY_UPDATE, id, content),
  deleteMemory: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MEMORY_DELETE, id),

  // ---------- 技能 ----------
  listSkills: (): Promise<SkillRecord[]> => ipcRenderer.invoke(IPC.SKILL_LIST),
  getSkill: (id: string): Promise<SkillRecord | null> =>
    ipcRenderer.invoke(IPC.SKILL_GET, id),
  // §328：类型要带上失败分支——safeHandle 把抛错与 zod 拒绝转成 resolve 的 `{ok:false}`，
  // 只写 `Promise<SkillRecord>` 就是让调用处"看上去判不了"（运行期看得见，只有 tsc 看不见这一面）
  saveSkill: (record: Partial<SkillRecord> & { name: string }): Promise<
    SkillRecord | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }
  > => ipcRenderer.invoke(IPC.SKILL_SAVE, record),
  deleteSkill: (id: string): Promise<{ ok: boolean; filesRemoved?: boolean }> =>
    ipcRenderer.invoke(IPC.SKILL_DELETE, id),
  exportSkill: (
    id: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SKILL_EXPORT, id),
  importSkill: (): Promise<{
    ok: boolean
    canceled?: boolean
    skill?: SkillRecord
    nameDuplicated?: boolean
    error?: string
  }> => ipcRenderer.invoke(IPC.SKILL_IMPORT),
  /* §236：目录导入与「这条技能带了哪些文件」。两个返回类型都带失败分支（safeHandle 把抛错转成返回值）。 */
  importSkillFolder: (): Promise<
    | {
        ok: boolean
        canceled?: boolean
        skill?: SkillRecord
        copied?: string[]
        skipped?: Array<{ path: string; reason: string }>
        ignoredKeys?: string[]
        forcedOnDemand?: boolean
        nameDuplicated?: boolean
        error?: string
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.SKILL_IMPORT_FOLDER),
  listSkillFiles: (id: string): Promise<
    { ok: true; files: Array<{ path: string; size: number }> } | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.SKILL_LIST_FILES, id),
  syncSkills: (): Promise<{ count: number; errors: string[] } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.SKILL_SYNC),
  fetchSkillIndex: (
    indexUrl: string
  ): Promise<{ ok: boolean; skills?: Array<{ id: string; name: string; description?: string; icon?: string; url: string }>; error?: string }> =>
    ipcRenderer.invoke(IPC.SKILL_FETCH_INDEX, indexUrl),
  importSkillFromUrl: (
    url: string
  ): Promise<{ ok: boolean; skill?: SkillRecord; error?: string }> =>
    ipcRenderer.invoke(IPC.SKILL_IMPORT_URL, url),
  validateSkill: (text: string): Promise<{ ok: boolean; error?: string; warnings: string[]; shape?: { name: string; description: string; icon: string; content: string } }> =>
    ipcRenderer.invoke(IPC.SKILL_VALIDATE, text),
  getSkillTemplates: (): Promise<Array<{ id: string; name: string; description: string; shape: { name: string; description: string; icon: string; content: string } }>> =>
    ipcRenderer.invoke(IPC.SKILL_TEMPLATES),

  // ---------- 会话 ----------
  listConversations: (assistantId?: string, isAgent?: boolean, archivedOnly?: boolean): Promise<ConversationRecord[]> =>
    ipcRenderer.invoke(IPC.CONVERSATION_LIST, assistantId, isAgent, archivedOnly),
  getConversation: (id: string): Promise<ConversationRecord | null | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GET, id),
  listChildConversations: (id: string): Promise<ConversationRecord[] | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_LIST_CHILDREN, id),
  setConversationPinned: (id: string, pinned: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SET_PINNED, id, pinned),
  setConversationArchived: (id: string, archived: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SET_ARCHIVED, id, archived),
  createConversation: (assistantId?: string | null, title?: string): Promise<ConversationRecord> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CREATE, assistantId, title),
  deleteConversation: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE, id),
  deleteConversations: (ids: string[]): Promise<{ ok: boolean; deleted: number }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_BATCH_DELETE, ids),
  renameConversation: (id: string, title: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_RENAME, id, title),
  exportConversationMd: (id: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_MD, id),
  exportConversationHtml: (id: string, html: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_HTML, id, html),
  exportConversationsBatch: (files: Array<{ name: string; content: string }>): Promise<{ ok: boolean; canceled?: boolean; count?: number; dir?: string; failed?: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_BATCH, files),
  exportMessages: (payload: { defaultName: string; content: string }): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_MESSAGES, payload),
  // 导出拖拽：prepare 预写临时文件（pointerdown 异步调），startDrag 在 dragstart 里同步 send
  prepareExportDrag: (payload: { defaultName: string; ext: 'md' | 'png'; content: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.EXPORT_PREPARE_DRAG, payload),
  startExportDrag: (path: string): void =>
    ipcRenderer.send(IPC.EXPORT_START_DRAG, { path }),
  exportConversationPdf: (id: string, html: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_PDF, id, html),
  exportConversationsPdfBatch: (files: Array<{ name: string; content: string }>): Promise<{ ok: boolean; canceled?: boolean; count?: number; dir?: string; failed?: string[]; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_PDF_BATCH, files),
  exportConversationEncrypted: (id: string, password: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_ENCRYPTED, id, password),
  importConversationEncrypted: (password: string): Promise<{ ok: boolean; canceled?: boolean; conversationId?: string; messageCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_IMPORT_ENCRYPTED, password),
  importConversation: (payload: ConversationExportPayload): Promise<{ ok: boolean; conversationId?: string; messageCount?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_IMPORT, payload),
  /** 外部平台记录导入（ChatGPT/Claude；渲染端读好文件文本传入，≤10 个文件）；assistantId 指定归属助手，null=自由会话 */
  importExternalConversations: (
    files: Array<{ name: string; text: string }>,
    assistantId?: string | null
  ): Promise<ConversationExternalImportResult> =>
    ipcRenderer.invoke(IPC.CONVERSATION_IMPORT_EXTERNAL, { files, assistantId: assistantId ?? null }),
  forkConversation: (conversationId: string, messageId: string): Promise<{ ok: boolean; conversation?: ConversationRecord; error?: string }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_FORK, conversationId, messageId),
  getSmartTitleEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SMART_TITLE_GET),
  setSmartTitleEnabled: (enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SMART_TITLE_SET, enabled),
  getConversationDraft: (id: string): Promise<string> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DRAFT_GET, id),
  setConversationDraft: (id: string, draft: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DRAFT_SET, id, draft),
  deleteConversationIfEmpty: (id: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_DELETE_IF_EMPTY, id),
  cleanupEmptyConversations: (): Promise<{ deleted: number }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_CLEANUP_EMPTY),
  listConversationGroups: (assistantId?: string | null): Promise<import('../shared/types').ConversationGroupRecord[]> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GROUP_LIST, assistantId ?? null),
  createConversationGroup: (assistantId: string | null, name: string): Promise<import('../shared/types').ConversationGroupRecord> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GROUP_CREATE, assistantId, name),
  renameConversationGroup: (id: string, name: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GROUP_RENAME, id, name),
  deleteConversationGroup: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_GROUP_DELETE, id),
  /** 改归属助手（assistantId=null=自由会话）；分组按助手过滤，移动会清组 */
  setConversationAssistant: (
    payload: import('../shared/types').ConversationSetAssistantPayload
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.CONVERSATION_SET_ASSISTANT, payload),
    setConversationGroup: (convId: string, groupId: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SET_GROUP, convId, groupId),
  setConversationNote: (convId: string, note: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SET_NOTE, convId, note),
  setConversationSystemPromptOverride: (convId: string, text: string | null): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CONVERSATION_SET_SYSTEM_PROMPT_OVERRIDE, convId, text),

  // ---------- 窗口行为（开机自启/关窗到托盘） ----------
  getWindowBehavior: (): Promise<import('../shared/types').WindowBehaviorSettings> =>
    ipcRenderer.invoke(IPC.WINDOW_BEHAVIOR_GET),
  setLaunchAtLogin: (enabled: boolean): Promise<import('../shared/types').WindowBehaviorSettings> =>
    ipcRenderer.invoke(IPC.WINDOW_BEHAVIOR_SET_LAUNCH, enabled),
  setCloseToTray: (enabled: boolean): Promise<import('../shared/types').WindowBehaviorSettings> =>
    ipcRenderer.invoke(IPC.WINDOW_BEHAVIOR_SET_CLOSE_TO_TRAY, enabled),

  // ---------- 消息 ----------
  listMessages: (conversationId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_LIST, conversationId),
  deleteMessage: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MESSAGE_DELETE, id),
  deleteMessagesBatch: (ids: string[]): Promise<{ ok: boolean; deleted: number }> =>
    ipcRenderer.invoke(IPC.MESSAGE_DELETE_BATCH, ids),
  truncateMessagesFrom: (id: string): Promise<{ ok: boolean; deleted: number }> =>
    ipcRenderer.invoke(IPC.MESSAGE_TRUNCATE_FROM, id),
  searchMessages: (
    query: string,
    assistantId?: string | null,
    dateRange?: { from?: number; to?: number },
    offset?: number
  ): Promise<MessageSearchResult[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_SEARCH, query, assistantId, dateRange, offset),
  setMessageStarred: (id: string, starred: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MESSAGE_SET_STARRED, id, starred),
  listStarredMessages: (limit?: number): Promise<StarredMessageItem[]> =>
    ipcRenderer.invoke(IPC.MESSAGE_LIST_STARRED, limit),
  setMessagePinned: (id: string, pinned: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.MESSAGE_SET_PINNED, id, pinned),
  forwardMessage: (input: {
    targetConvId: string | null
    sourceConvId: string | null
    role: 'user' | 'assistant'
    content: string
    model: string | null
  }): Promise<{ ok: boolean; convId: string; messageId: string }> =>
    ipcRenderer.invoke(IPC.MESSAGE_FORWARD, input),
  getUsageSummary: (days?: number): Promise<UsageSummary> =>
    ipcRenderer.invoke(IPC.USAGE_GET, days),
  getUsageConversations: (days?: number, limit?: number): Promise<UsageConversationItem[]> =>
    ipcRenderer.invoke(IPC.USAGE_CONVERSATIONS, days, limit),
  getUsageAssistants: (days?: number, limit?: number): Promise<UsageAssistantItem[]> =>
    ipcRenderer.invoke(IPC.USAGE_ASSISTANTS, days, limit),
  getUsagePricing: (): Promise<UsagePricing> =>
    ipcRenderer.invoke(IPC.USAGE_PRICING_GET),
  setUsagePricing: (pricing: UsagePricing): Promise<UsagePricing> =>
    ipcRenderer.invoke(IPC.USAGE_PRICING_SET, pricing),
  listUsageModels: (): Promise<UsageModelItem[]> =>
    ipcRenderer.invoke(IPC.USAGE_MODELS),
  getUsageBudget: (): Promise<import('../shared/types').UsageBudgetStatus> =>
    ipcRenderer.invoke(IPC.USAGE_BUDGET_GET),
  setUsageBudget: (daily: number | null, monthly: number | null, hardBlock?: boolean, warn?: boolean): Promise<import('../shared/types').UsageBudgetStatus> =>
    ipcRenderer.invoke(IPC.USAGE_BUDGET_SET, daily, monthly, hardBlock, warn),
  getUsageDetail: (days?: number, limit?: number, conversationId?: string, assistantId?: string | null): Promise<UsageDetailResult> =>
    ipcRenderer.invoke(IPC.USAGE_DETAIL_GET, days, limit, conversationId, assistantId),
  exportUsageCsv: (
    payload: { days: number; content: string }
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.USAGE_EXPORT_CSV, payload),
  // refresh=true：连浏览器缓存那一格也重算（面板那颗「刷新」按钮；平时走进程内缓存，V4-Iter-177）
  getDataHealth: (refresh = false): Promise<DataHealthReport> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_GET, refresh),
  openDataFolder: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_OPEN_DIR),
  clearBrowserCache: (): Promise<{ ok: boolean; beforeBytes: number; afterBytes: number; error?: string }> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_CLEAR_CACHE),
  // 本机判据屏（V4-Iter-146）：只读汇总，一次进来会现采一次显存（异步，不占事件循环）
  getLocalJudgement: (): Promise<LocalJudgementReport> =>
    ipcRenderer.invoke(IPC.LOCAL_JUDGEMENT_GET),
  // KB 数据健康修复动作（探测只读随 getDataHealth 返回）
  cleanKbOrphans: (): Promise<{ removedVectors: number; removedChunks: number }> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_KB_CLEAN),
  deduplicateKbDocs: (keepDocId: string): Promise<{ removed: number }> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_KB_DEDUP, keepDocId),
  reindexKbDocs: (docIds: string[]): Promise<{ enqueued: number }> =>
    ipcRenderer.invoke(IPC.DATA_HEALTH_KB_REINDEX, docIds),
  // 运行期性能事件上报（fire-and-forget；入慢操作环形缓冲，数据健康面板可见）
  reportPerf: (label: string, ms: number): Promise<void> =>
    ipcRenderer.invoke(IPC.PERF_EVENT, { label, ms }),

  // ---------- 聊天 ----------
  // 成功侧确实没有值（`chatService.send()` 是 `Promise<void>`），但 safeHandle 会把抛错转成
  // `{ok:false,error}` **返回值**：类型只写 `Promise<void>` 就是在教调用方"这个值不用看"
  // ——`ChatModule` 那句 `.then((r) => { void r })` 就是这么写出来的（V4-Iter-196 的漏点，204 才抓到）。
  sendMessage: (payload: SendMessagePayload): Promise<void | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.CHAT_SEND, payload),
  regenerateMessage: (payload: RegeneratePayload): Promise<void | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.CHAT_REGENERATE, payload),
  resendMessage: (payload: ResendPayload): Promise<void | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.CHAT_RESEND, payload),
  // §265：类型诚实化（照 §258 那三发的写法）——`safeHandle` 会把失败以**已 resolve 的 `{ok:false,error}`** 送回来，
  // 原来标成 `Promise<{ ok: boolean }>` 就是在告诉调用方"不会失败"，于是没人判它，而界面下一句已经改成"已停"。
  abortChat: (requestId: string): Promise<{ ok: boolean; error?: string }> =>
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
  onConversationTitle: (handler: (e: ConversationTitleEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ConversationTitleEvent) => handler(data)
    ipcRenderer.on(IPC.CONVERSATION_TITLE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CONVERSATION_TITLE_EVENT, listener)
  },

  // ---------- KB 问答模式 ----------
  // §318：这一条与下面 createLocalBackup／syncSkills 原本只写成功形状（如 `{ requestId; sources }`），
  // 把 safeHandle 一定会产出的 `{ ok:false }` 从类型里抹掉了 ⇒ 消费侧「解构即数据」编译器不响，
  // 那五面静默闸门也看不见这几根通道。类型诚实之后，判不判信封由 TS 兜着。
  kbAsk: (args: {
    kbIds: string[]
    providerId: string
    model: string
    question: string
    history: { role: 'user' | 'assistant'; content: string }[]
  }): Promise<{ requestId: string; sources: MessageSource[] } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.KB_ASK, args),
  kbAskAbort: (requestId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_ASK_ABORT, requestId),
  onKbAskChunk: (handler: (e: KbAskChunkEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: KbAskChunkEvent) => handler(data)
    ipcRenderer.on(IPC.KB_ASK_CHUNK_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.KB_ASK_CHUNK_EVENT, listener)
  },
  onKbAskDone: (handler: (e: KbAskDoneEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: KbAskDoneEvent) => handler(data)
    ipcRenderer.on(IPC.KB_ASK_DONE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.KB_ASK_DONE_EVENT, listener)
  },
  onKbAskError: (handler: (e: KbAskErrorEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: KbAskErrorEvent) => handler(data)
    ipcRenderer.on(IPC.KB_ASK_ERROR_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.KB_ASK_ERROR_EVENT, listener)
  },
  saveKbAskSession: (record: KbAskSessionRecord): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_SAVE, record),
  listKbAskSessions: (kbId: string): Promise<KbAskSessionMeta[]> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_LIST, kbId),
  getKbAskSession: (
    id: string
  ): Promise<
    | KbAskSessionRecord
    | null
    | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }
  > => ipcRenderer.invoke(IPC.KB_ASK_SESSION_GET, id),
  deleteKbAskSession: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_DELETE, id),
  renameKbAskSession: (id: string, title: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_RENAME, id, title),
  exportKbAskSessionMd: (id: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_EXPORT_MD, id),
  exportKbAskSessionHtml: (id: string, html: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_EXPORT_HTML, id, html),
  searchKbAskSessions: (kbId: string, keyword: string): Promise<KbAskSessionMeta[]> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_SEARCH, kbId, keyword),
  listAllKbAskSessions: (limit = 200): Promise<KbAskRoamItem[]> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_LIST_ALL, limit),
  searchAllKbAskSessions: (keyword: string, limit = 200): Promise<KbAskRoamItem[]> =>
    ipcRenderer.invoke(IPC.KB_ASK_SESSION_SEARCH_ALL, keyword, limit),
  getKbAskRetention: (): Promise<KbAskRetention> =>
    ipcRenderer.invoke(IPC.KB_ASK_RETENTION_GET),
  setKbAskRetention: (policy: KbAskRetention): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_ASK_RETENTION_SET, policy),

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
  addKbFiles: (
    kbId: string
  ): Promise<{ docs: KbDocument[]; skippedSameSource: number; skippedSameContent: number }> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_FILE, kbId),
  addKbFolder: (kbId: string): Promise<{
    docs: KbDocument[]
    skippedCount: number
    truncated: boolean
    skippedSameSource: number
    skippedSameContent: number
  }> => ipcRenderer.invoke(IPC.KB_DOC_ADD_FOLDER, kbId),
  addKbUrl: (kbId: string, url: string, title?: string): Promise<{ doc: KbDocument | null; duplicated: boolean }> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_URL, kbId, url, title),
  addKbText: (kbId: string, text: string, title: string): Promise<KbDocument | null> =>
    ipcRenderer.invoke(IPC.KB_DOC_ADD_TEXT, kbId, text, title),
  deleteKbDocument: (docId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_DOC_DELETE, docId),
  reindexKbDocument: (kbId: string, docId: string): Promise<KbDocument> =>
    ipcRenderer.invoke(IPC.KB_DOC_REINDEX, kbId, docId),
  /** 读取 txt 文档原文供编辑（非 txt/旧版无原文返回 null） */
  getKbDocText: (docId: string): Promise<{ title: string; text: string } | null> =>
    ipcRenderer.invoke(IPC.KB_DOC_GET_TEXT, docId),
  /** 编辑 txt 文档标题+原文（保存后后台自动重建索引） */
  updateKbDocText: (
    docId: string,
    title: string,
    text: string
  ): Promise<KbDocument | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }> =>
    ipcRenderer.invoke(IPC.KB_DOC_UPDATE_TEXT, docId, title, text),
  /** 重命名文档标题（全部类型，不重建索引） */
  renameKbDocument: (
    docId: string,
    title: string
  ): Promise<KbDocument | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }> =>
    ipcRenderer.invoke(IPC.KB_DOC_RENAME, docId, title),
  checkKbUpdates: (kbId: string): Promise<{
    checked: number
    unchanged: number
    issues: { docId: string; title: string; source: string; kind: 'changed' | 'missing' }[]
  }> => ipcRenderer.invoke(IPC.KB_SYNC_CHECK, kbId),
  setKbDocEnabled: (kbId: string, docId: string, enabled: boolean): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.KB_DOC_SET_ENABLED, kbId, docId, enabled),
  /** 选一份评测集 JSON；返回主进程签发的路径令牌（SEC-6），渲染层拿不到绝对路径 */
  pickKbEvalSet: (): Promise<{ token: string; fileName: string } | null> =>
    ipcRenderer.invoke(IPC.KB_EVAL_PICK),
  /** 按卷子逐条跑真检索打分；k 不传 = 用该库自己的 topN */
  runKbEval: (kbId: string, token: string, k?: number): Promise<KbEvalRunResult> =>
    ipcRenderer.invoke(IPC.KB_EVAL_RUN, kbId, token, k),

  listKbChunks: (docId: string): Promise<KbChunk[]> =>
    ipcRenderer.invoke(IPC.KB_CHUNK_LIST, docId),
  retrieveKb: (kbIds: string[], query: string): Promise<RetrievalResult> =>
    ipcRenderer.invoke(IPC.KB_RETRIEVE, kbIds, query),
  retrieveKbDebug: (kbIds: string[], query: string): Promise<{ result: RetrievalResult; diagnostics: import('../shared/types').RetrievalDiagnostics }> =>
    ipcRenderer.invoke(IPC.KB_RETRIEVE_DEBUG, kbIds, query),

  // ---------- MCP Server ----------
  listMcpServers: (): Promise<McpServerRecord[]> => ipcRenderer.invoke(IPC.MCP_SERVER_LIST),
  /** 导出全部 MCP 配置（showSaveDialog；敏感值已脱敏；canceled 表示用户取消） */
  exportMcpServers: (): Promise<
    { ok: true; canceled: true } | { ok: true; path: string; count: number; redactedCount: number } | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.MCP_SERVER_EXPORT),
  getMcpServer: (id: string): Promise<McpServerRecord | null> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_GET, id),
  /** 按需揭示单个 Server 的 env/headers 真实值（列表与表单默认为掩码视图） */
  revealMcpSecrets: (
    id: string
  ): Promise<{ ok: boolean; env?: Record<string, string>; headers?: Record<string, string>; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_REVEAL_SECRETS, id),
  saveMcpServer: (
    record: Partial<McpServerRecord> & { name: string }
  ): Promise<McpServerRecord | { ok: false; error: string }> => ipcRenderer.invoke(IPC.MCP_SERVER_SAVE, record),
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
  // 面板手动试运行：argsJson 为未解析 JSON 字符串，解析在主进程做
  callMcpServerTool: (
    id: string,
    name: string,
    argsJson: string
  ): Promise<{ ok: boolean; content?: string; isError?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_CALL_TOOL, { serverId: id, toolName: name, argsJson }),
  getMcpRuntimes: (): Promise<McpServerRuntime[]> =>
    ipcRenderer.invoke(IPC.MCP_SERVER_GET_RUNTIMES),
  /** 工具调用记录（跨重启可查）；serverId 省略/null = 全部 */
  listMcpCallLogs: (
    serverId?: string | null,
    limit?: number | null
  ): Promise<{ ok: boolean; logs?: McpCallLogRecord[]; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_CALL_LOG_LIST, serverId ?? null, limit ?? null),
  clearMcpCallLogs: (
    serverId?: string | null
  ): Promise<{ ok: boolean; removed?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.MCP_CALL_LOG_CLEAR, serverId ?? null),

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
  // §332：这七条改前的返回类型只写成功形状（`Note[]`／`Note`／`Note | null`／`{ ok: boolean }`）⇒
  // safeHandle 把抛错与 zod 拒绝折成 resolve 的 `{ok:false}` 时，tsc 不会逼调用点判，
  // 失败对象就被当记录用（本批崩屏两条的温床）。口径同 §318／§330／§331。
  listNotes: (): Promise<Note[] | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_LIST),
  getNote: (
    id: string
  ): Promise<Note | null | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_GET, id),
  createNote: (input: {
    title?: string
    content?: string
    tags?: string[]
  }): Promise<Note | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_CREATE, input),
  updateNote: (
    id: string,
    patch: Partial<Pick<Note, 'title' | 'content' | 'pinned'>> & { tags?: string[] }
  ): Promise<Note | null | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_UPDATE, id, patch),
  deleteNote: (
    id: string
  ): Promise<{ ok: true } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_DELETE, id),
  searchNotes: (
    keyword: string
  ): Promise<Note[] | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_SEARCH, keyword),
  createNoteFromMessage: (input: {
    title?: string
    content: string
  }): Promise<Note | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.NOTES_CREATE_FROM_MESSAGE, input),

  // ---------- 提示词片段 ----------
  listPromptSnippets: (): Promise<PromptSnippetRecord[]> => ipcRenderer.invoke(IPC.SNIPPETS_LIST),
  createPromptSnippet: (input: {
    title: string
    content: string
  }): Promise<PromptSnippetRecord> => ipcRenderer.invoke(IPC.SNIPPETS_CREATE, input),
  updatePromptSnippet: (
    id: string,
    patch: Partial<Pick<PromptSnippetRecord, 'title' | 'content'>>
  ): Promise<PromptSnippetRecord | null> => ipcRenderer.invoke(IPC.SNIPPETS_UPDATE, id, patch),
  deletePromptSnippet: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.SNIPPETS_DELETE, id),
  exportPromptSnippets: (): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.SNIPPETS_EXPORT),
  importPromptSnippets: (): Promise<{ ok: boolean; canceled?: boolean; imported?: number; overwritten?: number; skipped?: number; error?: string }> =>
    ipcRenderer.invoke(IPC.SNIPPETS_IMPORT),

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
  }): Promise<GlossaryTerm | { ok: false; error: string }> => ipcRenderer.invoke(IPC.GLOSSARY_SAVE, input),
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
  /** 灯箱：复制图片 data URL 到系统剪贴板 */
  writeImageClipboard: (dataUrl: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_IMAGE, { dataUrl }),
  /** 灯箱：图片 data URL 另存为（用户取消返回 { canceled: true }） */
  saveDataUrlImage: (
    dataUrl: string,
    defaultName?: string
  ): Promise<{ canceled: true } | { path: string }> =>
    ipcRenderer.invoke(IPC.IMAGE_SAVE_DATAURL, { dataUrl, defaultName }),

  // ---------- 工具 ----------
  listAvailableTools: (): Promise<ToolSchema[]> => ipcRenderer.invoke(IPC.TOOL_LIST_AVAILABLE),

  // ---------- Work Agent ----------
  // §265：同 abortChat——类型不许再说"不会失败"（这一发的结果过去连 `.catch` 都没有，界面已经替它说"已停"）
  abortAgent: (requestId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.AGENT_ABORT, requestId),
  // 运行中插队（V4-Iter-238）：ok:false 表示这轮运行已经收不到（结束/不是主干），
  // 界面据此把消息退回队列而不是当成"发出去了"
  interjectAgent: (payload: {
    requestId: string
    clientRef: string
    text: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_INTERJECT, payload),
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

  // ---------- 本地日历配置（calendar.read） ----------
  getCalendarConfig: (): Promise<CalendarConfig> =>
    ipcRenderer.invoke(IPC.AGENT_GET_CALENDAR_CONFIG),
  setCalendarConfig: (
    patch: Partial<Pick<CalendarConfig, 'enabled' | 'paths'>>
  ): Promise<CalendarConfig> => ipcRenderer.invoke(IPC.AGENT_SET_CALENDAR_CONFIG, patch),
  pickIcsFile: (): Promise<{ canceled: boolean; path?: string }> =>
    ipcRenderer.invoke(IPC.AGENT_PICK_ICS_FILE),
  /** 会话最近一次 Agent 运行统计（步数/耗时/token）；无记录返回 null */
  getLatestRunStats: (conversationId: string): Promise<AgentRunStats | null> =>
    ipcRenderer.invoke(IPC.AGENT_GET_LATEST_RUN_STATS, conversationId),
  /** 会话最近一次 Agent 运行分步明细（step_index 升序）；无记录返回空数组 */
  getLatestRunTraces: (conversationId: string): Promise<AgentTraceRecord[]> =>
    ipcRenderer.invoke(IPC.AGENT_GET_LATEST_RUN_TRACES, conversationId),
  /** 会话级累计统计（跨全部运行：运行次数/总耗时/总 token）；无记录返回 null */
  getSessionStats: (conversationId: string): Promise<AgentSessionStats | null> =>
    ipcRenderer.invoke(IPC.AGENT_GET_SESSION_STATS, conversationId),
  /** 被点名「走文本协议」的模型清单（元素形如 `providerId::model`） */
  getAgentTextProtocol: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC.AGENT_GET_TEXT_PROTOCOL),
  /** 开/关某台模型的文本协议；返回最新清单（以库里为准，调用方不做乐观更新） */
  setAgentTextProtocol: (providerId: string, model: string, on: boolean): Promise<string[]> =>
    ipcRenderer.invoke(IPC.AGENT_SET_TEXT_PROTOCOL, { providerId, model, on }),
  /** §234：每台模型声明的上下文窗口（键 `providerId::model`，值为 token 数）。失败分支是 {ok:false} */
  getModelContextWindows: (): Promise<Record<string, number> | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_GET_MODEL_WINDOWS),
  /** §234：设/清一台模型的上下文窗口（tokens=null 为清除）；回传最新表＋拒绝码，调用方不做乐观更新 */
  setModelContextWindow: (
    providerId: string,
    model: string,
    tokens: number | null
  ): Promise<{ windows: Record<string, number>; rejected?: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_SET_MODEL_WINDOW, { providerId, model, tokens }),
  // §237：每台模型的备用 target（`providerId::model` → 一台）。表里没有的那台＝没设过＝一句都不换。
  getFallbackTargets: (): Promise<
    Record<string, { providerId: string; model: string }> | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.AGENT_GET_FALLBACKS),
  /** 设/清某台模型的备用（target=null 为清除）；回传最新表＋拒绝码，调用方不做乐观更新 */
  setFallbackTarget: (
    providerId: string,
    model: string,
    target: { providerId: string; model: string } | null
  ): Promise<
    | { targets: Record<string, { providerId: string; model: string }>; rejected?: string }
    | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.AGENT_SET_FALLBACK, { providerId, model, target }),
  /** 已判出的"这台模型当得了管控者吗"清单（带 stale：本地镜像换了就该重探） */
  listDelegateCapabilities: (): Promise<DelegateCapabilityView[]> =>
    ipcRenderer.invoke(IPC.AGENT_LIST_DELEGATE_CAPS),
  /** §246 停止正在跑的那一发；`stopped:false` = 这一台此刻没在探（没什么可停） */
  abortDelegateProbe: (
    providerId: string,
    model: string
  ): Promise<{ stopped: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_ABORT_DELEGATE_PROBE, { providerId, model }),
  /** 对一台模型跑一次委派探针（默认 3 发真请求，走原生 tools 路径）；失败原因在 error 里 */
  probeDelegateCapability: (providerId: string, model: string): Promise<DelegateProbeResult> =>
    ipcRenderer.invoke(IPC.AGENT_PROBE_DELEGATE_CAP, { providerId, model }),
  /** 决策③：点名允许/取消某台模型做顺序委派。前置条件在主进程判，拒绝**只回码**（152），句子由界面按语言拼 */
  setAgentDelegateEnabled: (
    providerId: string,
    model: string,
    on: boolean
  ): Promise<{ ok: boolean; error: DelegateFailure | string | null; models: string[] }> =>
    ipcRenderer.invoke(IPC.AGENT_SET_DELEGATE_ENABLED, { providerId, model, on }),
  /**
   * §231「还原到写入前」：一条写操作一次机会，快照用过即废。
   * 类型带失败分支（与 205 那一族同口径）——写成 `Promise<{path: string}>` 就等于让界面以为它不会失败。
   */
  restoreFileWrite: (
    snapshotId: string
  ): Promise<
    { ok: true; path: string; bytes: number; removed: boolean } | { ok: false; error: string }
  > => ipcRenderer.invoke(IPC.AGENT_RESTORE_FILE_WRITE, snapshotId),

  // ---------- Agent 评测集（V4-Iter-242）----------
  /**
   * 跑一趟评测：分钟级、花额度，所以每一发都靠 `onAgentEvalProgress` 往外推。
   * 类型必须带失败分支——"这已经在跑了""现在有 Agent 运行没停"这两档界面要拿得到，
   * 写成 `Promise<AgentEvalRunResult>` 就是让界面以为它不会失败（205 那一族的口径）。
   */
  runAgentEval: (
    payload: { providerId: string; model: string; tier?: 'smoke' | 'full'; k?: number }
  ): Promise<AgentEvalRunResult | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_EVAL_RUN, payload),
  /** 喊停：正在跑的那发被打断、剩下的发不再开。`stopped:false` ＝当下没有评测在跑（不是失败） */
  stopAgentEval: (): Promise<{ stopped: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_EVAL_STOP),
  /** 落盘报告的清单（按时间倒序，最多 20 份）：每次点开都重跑一遍要花额度，所以旧数字要能读回来 */
  listAgentEvalReports: (): Promise<AgentEvalReportEntry[] | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_EVAL_REPORTS),
  readAgentEvalReport: (
    fileName: string
  ): Promise<{ text: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.AGENT_EVAL_READ_REPORT, fileName),

  // ---------- License 授权 ----------
  activateLicense: (code: string): Promise<LicenseStatus> =>
    ipcRenderer.invoke(IPC.LICENSE_ACTIVATE, code),
  importLicenseFile: (): Promise<{ canceled: boolean; status?: LicenseStatus }> =>
    ipcRenderer.invoke(IPC.LICENSE_IMPORT_FILE),
  /** 本机硬盘指纹（16 位 hex）；null = 无法读取 */
  getLicenseFingerprint: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.LICENSE_GET_FINGERPRINT),
  /** 卡密在线激活：客户端自动附带本机硬盘指纹请求激活服务器；失败返回 { ok:false, code } */
  onlineActivateLicense: (code: string): Promise<ActivationResult> =>
    ipcRenderer.invoke(IPC.LICENSE_ONLINE_ACTIVATE, code),

  // ---------- 独立窗口 ----------
  openDetachedWindow: (moduleId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.APP_OPEN_DETACHED, moduleId),

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
    approved: boolean,
    alwaysAllow = false
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.AGENT_TOOL_APPROVE_RESPONSE, { approvalId, approved, alwaysAllow }),

  // ---------- Channels（IM Bot 网关；Token 明文不出主进程） ----------
  getChannelConfig: (type: ChannelType): Promise<ChannelConfig> =>
    ipcRenderer.invoke(IPC.CHANNEL_GET_CONFIG, type),
  setChannelConfig: (
    type: ChannelType,
    patch: Partial<
      Pick<
        ChannelConfig,
        | 'enabled'
        | 'whitelist'
        | 'appId'
        | 'assistantId'
        | 'providerId'
        | 'model'
        | 'agentMode'
      >
    > & { primarySecret?: string; secondarySecret?: string }
  ): Promise<ChannelConfig> => ipcRenderer.invoke(IPC.CHANNEL_SET_CONFIG, type, patch),
  startChannel: (type: ChannelType): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CHANNEL_START, type),
  stopChannel: (type: ChannelType): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.CHANNEL_STOP, type),
  /** 一次性读取所有网关状态快照（启动后初始化 UI） */
  listChannelStatus: (): Promise<Record<string, { status: string; lastError: string | null }>> =>
    ipcRenderer.invoke(IPC.CHANNEL_LIST_STATUS),
  /** 订阅网关状态变化；返回退订函数 */
  onChannelStatus: (handler: (e: ChannelStatusEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ChannelStatusEvent) => handler(data)
    ipcRenderer.on(IPC.CHANNEL_STATUS_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.CHANNEL_STATUS_EVENT, listener)
  },

  // ---------- 沙箱（v2 批次八：沙箱基础层） ----------
  // §326：这四条的失败形状写进类型（safeHandle 把抛错／入参拒绝转成 resolve 的 `{ok:false}`，
  // 只挂 .catch 接不住；类型撒谎时 §250／§263 那几面闸门全瞎，tsc 才是那道判据）
  listSandboxFiles: (): Promise<SandboxFileMeta[] | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.SANDBOX_LIST),
  createSandboxFile: (
    name: string,
    html: string,
    opts?: { icon?: string; description?: string; isApp?: boolean }
  ): Promise<SandboxFileMeta | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.SANDBOX_CREATE, { name, html, opts }),
  getSandboxFile: (
    id: string
  ): Promise<{ meta: SandboxFileMeta; html: string } | null | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.SANDBOX_GET, id),
  deleteSandboxFile: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.SANDBOX_DELETE, id),
  updateSandboxMeta: (
    id: string,
    patch: { name?: string; icon?: string; description?: string; isApp?: boolean }
  ): Promise<
    SandboxFileMeta | null | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }
  > => ipcRenderer.invoke(IPC.SANDBOX_UPDATE_META, { id, patch }),

  // ---------- 快捷浮窗（快捷问答 / 选区助手） ----------
  hidePopup: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.POPUP_HIDE),
  openSelectionPopup: (
    text: string,
    action: import('../shared/types').SelectionAction
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.POPUP_OPEN_SELECTION, { text, action }),
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

  // ---------- 回复完成系统通知 ----------
  getReplyNotifyEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.NOTIFY_REPLY_GET),
  setReplyNotifyEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.NOTIFY_REPLY_SET, enabled),
  showReplyNotification: (payload: { title: string; body: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.NOTIFY_REPLY_SHOW, payload),

  // ---------- 网络代理（成功返回规整 URL，''=直连；失败返回 { ok:false, error }） ----------
  getProxyUrl: (): Promise<string> =>
    ipcRenderer.invoke(IPC.NET_PROXY_GET),
  setProxyUrl: (url: string): Promise<string | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.NET_PROXY_SET, url),

  // ---------- 侧栏模块顺序与固定 ----------
  getSidebarOrder: (): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_GET_ORDER),
  setSidebarOrder: (
    order: import('../shared/types').SidebarModuleId[]
  ): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_SET_ORDER, order),
  getSidebarPinned: (): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_GET_PINNED),
  setSidebarPinned: (
    list: import('../shared/types').SidebarModuleId[]
  ): Promise<{ ok: boolean; data?: import('../shared/types').SidebarModuleId[]; error?: string }> =>
    ipcRenderer.invoke(IPC.SIDEBAR_SET_PINNED, list),
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
    handler: (e: AgentChunkEvent) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: AgentChunkEvent) => handler(data)
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
  /** 评测逐发进度（V4-Iter-242）：跑一趟是分钟级，没有这一栏界面就只能干等，等成"看起来卡死" */
  onAgentEvalProgress: (handler: (e: AgentEvalProgressEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: AgentEvalProgressEvent) => handler(data)
    ipcRenderer.on(IPC.AGENT_EVAL_PROGRESS_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.AGENT_EVAL_PROGRESS_EVENT, listener)
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
  unlockEncryption: (password: string): Promise<AuthResult> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_UNLOCK, password),
  getAuthLockState: (): Promise<AuthLockState> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_AUTH_STATUS),
  lockEncryption: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_LOCK),
  setMasterPassword: (password: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_SET_MASTER_PASSWORD, password),
  changePassword: (
    oldPassword: string,
    newPassword: string
  ): Promise<{ ok: boolean; error?: string; recoveryCode?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_CHANGE_PASSWORD, oldPassword, newPassword),
  disableEncryption: (password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_DISABLE, password),
  enableEncryption: (password: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_ENABLE, password),
  hasRecoveryKey: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_HAS_RECOVERY),
  generateRecoveryKey: (): Promise<{ ok: boolean; code?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_GENERATE_RECOVERY),
  disableRecoveryKey: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_DISABLE_RECOVERY),
  recoverWithCode: (
    code: string,
    newPassword: string
  ): Promise<AuthResult & { recoveryCode?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_RECOVER, { code, newPassword }),
  saveRecoveryFile: (
    code: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.ENCRYPTION_SAVE_RECOVERY_FILE, code),
  copySensitiveToClipboard: (
    text: string,
    ttlMs?: number
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.CLIPBOARD_COPY_SENSITIVE, text, ttlMs),

  // ---------- 备份 ----------
  createLocalBackup: (): Promise<{ path: string; size: number; encrypted: boolean } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL),
  createEncryptedLocalBackup: (): Promise<
    { ok: true; path: string; size: number; encrypted: boolean; saltB64: string }
    | { ok: false; error: string }
  > =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL_ENCRYPTED),
  restoreLocalBackup: (
    payload?: { restoreToken?: string; backupPassword?: string }
  ): Promise<import('../shared/types').BackupRestoreResult> =>
    ipcRenderer.invoke(IPC.BACKUP_LOCAL_RESTORE, payload),
  saveWebDAVConfig: (cfg: WebDAVConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_SAVE_CONFIG, cfg),
  loadWebDAVConfig: (): Promise<WebDAVConfig | null> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LOAD_CONFIG),
  testWebDAV: (cfg: WebDAVConfig): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_TEST, cfg),
  uploadWebDAVBackup: (): Promise<{ ok?: boolean; filename?: string; size?: number; encrypted?: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_UPLOAD),
  uploadIncrementalBackup: (): Promise<
    import('../shared/types').IncrementalBackupResult & { ok?: boolean; error?: string }
  > => ipcRenderer.invoke(IPC.BACKUP_WEBDAV_UPLOAD_INCREMENTAL),
  listWebDAVBackups: (): Promise<WebDAVBackupFile[] | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_LIST),
  restoreWebDAVBackup: (
    filename: string,
    backupPassword?: string
  ): Promise<import('../shared/types').BackupRestoreResult> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_RESTORE, filename, backupPassword),
  mergeScanWebDAVBackup: (
    filename: string,
    backupPassword?: string
  ): Promise<import('../shared/types').MergeConflictReport> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_MERGE_SCAN, filename, backupPassword),
  mergeExecuteWebDAVBackup: (
    filename: string,
    strategy: import('../shared/types').MergeStrategy,
    backupPassword?: string
  ): Promise<import('../shared/types').MergeExecuteResult> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_MERGE_EXECUTE, { filename, strategy, backupPassword }),
  deleteWebDAVBackup: (filename: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.BACKUP_WEBDAV_DELETE, filename),
  getBackupSchedule: (): Promise<BackupScheduleStatus> =>
    ipcRenderer.invoke(IPC.BACKUP_SCHEDULE_GET),
  setBackupSchedule: (
    patch: { enabled?: boolean; intervalHours?: number; retentionCount?: number }
  ): Promise<BackupScheduleStatus> =>
    ipcRenderer.invoke(IPC.BACKUP_SCHEDULE_SET, patch),

  // ---------- 自动更新 ----------
  getUpdateInfo: (): Promise<UpdateInfo> =>
    ipcRenderer.invoke(IPC.UPDATE_GET_INFO),
  checkUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK),
  downloadUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  quitAndInstall: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_QUIT_INSTALL),
  setAutoUpdate: (enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UPDATE_SET_SETTINGS, enabled),
  onUpdateEvent: (callback: (e: UpdateEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: UpdateEvent) => callback(data)
    ipcRenderer.on(IPC.UPDATE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.UPDATE_EVENT, listener)
  },
  fetchChangelog: (): Promise<{
    ok: boolean
    error?: string
    releases?: Array<{ tag: string; name: string; date: string; body: string; url: string; prerelease: boolean }>
  }> => ipcRenderer.invoke(IPC.CHANGELOG_FETCH),

  // ---------- 隐私锁 ----------
  getLockStatus: (): Promise<LockStatus> =>
    ipcRenderer.invoke(IPC.LOCK_GET_STATUS),
  lock: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_LOCK),
  unlock: (password?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.LOCK_UNLOCK, password),
  // §228：这一发现在会真落库 ⇒ 类型带上失败分支（safeHandle 把写失败转成 {ok:false,error}）
  setAutoLockTimeout: (timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.LOCK_SET_AUTO_TIMEOUT, timeoutMs),
  markActive: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LOCK_MARK_ACTIVE),
  onLockStateChange: (handler: (e: LockStateEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: LockStateEvent) => handler(data)
    ipcRenderer.on(IPC.LOCK_STATE_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.LOCK_STATE_EVENT, listener)
  },
  onReminderFired: (handler: (e: ReminderFiredPayload) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: ReminderFiredPayload) => handler(data)
    ipcRenderer.on(IPC.REMINDER_FIRED, listener)
    return () => ipcRenderer.removeListener(IPC.REMINDER_FIRED, listener)
  },
  /** 预算 80% 软预警（主进程在每轮 usage 落库后检查，同一日/月周期只推一次） */
  onUsageBudgetWarning: (handler: (e: import('../shared/types').BudgetWarnEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: import('../shared/types').BudgetWarnEvent) => handler(data)
    ipcRenderer.on(IPC.USAGE_BUDGET_WARNING_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.USAGE_BUDGET_WARNING_EVENT, listener)
  },
  /** 消息右键「提醒我」直建一次性提醒 */
  createReminder: (
    payload: ReminderCreatePayload
  ): Promise<
    | { ok: true; id: string; fireAt: number }
    | { ok: false; error: string; ipcCode?: string; ipcArgs?: unknown[] }
  > => ipcRenderer.invoke(IPC.REMINDER_CREATE, payload),
  /** 提醒列表：scope 缺省/pending=待发（按触发时间升序），history=已触发/错过/取消（倒序），上限 50 */
  listReminders: (scope?: 'pending' | 'history'): Promise<ReminderRecord[]> =>
    ipcRenderer.invoke(IPC.REMINDER_LIST, scope),
  /** 取消待发提醒；返回 ok=false 表示已触发/不存在 */
  cancelReminder: (id: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.REMINDER_CANCEL, id),
  /** 重新安排历史提醒（missed/cancelled/fired 行回 pending，可选改循环规则） */
  rescheduleReminder: (
    payload: import('../shared/types').ReminderReschedulePayload
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.REMINDER_RESCHEDULE, payload),
  /** 编辑 pending 提醒（改时间/文本/循环规则；repeatRule=null 清除变一次性） */
  updateReminder: (
    payload: import('../shared/types').ReminderUpdatePayload
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.REMINDER_UPDATE, payload),
  /** 一键重新安排 missed 循环提醒（按原 rule 重算下次触发回 pending） */
  rescheduleNextReminder: (
    id: string
  ): Promise<{ ok: boolean; fireAt?: number }> =>
    ipcRenderer.invoke(IPC.REMINDER_RESCHEDULE_NEXT, id),

  // ---------- 终端 ----------
  // §320：两条发起通道过去写成 `{ ok: boolean; ... }`——失败形状被类型抹平，消费点也就没人判。
  // 现在写成可判别联合（判完 `ok:false` 那一支，tsc 就接管剩下的一半），startTerminal 另回一个
  // **轮次号 epoch**：同一窗口重开终端时 webContents id 不变，渲染端只有靠它才分得出
  // 「这帧是刚起的那台 shell 的首屏」与「上一台被杀掉的 shell 迟到的退出」——后者会把 running 误置 false。
  startTerminal: (): Promise<{ ok: true; sessionId: number; epoch: number } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.TERMINAL_START),
  terminalInput: (data: string): Promise<{ ok: true } | { ok: false; error: string; ipcCode?: string; ipcArgs?: string }> =>
    ipcRenderer.invoke(IPC.TERMINAL_INPUT, { data }),
  killTerminal: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.TERMINAL_KILL),
  onTerminalOutput: (handler: (payload: { sessionId: number; epoch: number; stream: 'stdout' | 'stderr' | 'exit'; data: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: { sessionId: number; epoch: number; stream: 'stdout' | 'stderr' | 'exit'; data: string }) => handler(data)
    ipcRenderer.on(IPC.TERMINAL_OUTPUT, listener)
    return () => ipcRenderer.removeListener(IPC.TERMINAL_OUTPUT, listener)
  },

  // ---------- 平台管家 ----------
  // §258：同 getHardwareInfo／checkIntegrity 改信封
  getHealthReport: (): Promise<{ ok: boolean; data?: HealthReport; error?: string }> =>
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
  exportStewardReport: (
    content: string
  ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.STEWARD_EXPORT_REPORT, { content }),

  // ---------- 首启向导 ----------
  getWizardState: (): Promise<{ ok: boolean; data?: WizardState; error?: string }> =>
    ipcRenderer.invoke(IPC.WIZARD_GET_STATE),
  completeWizard: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.WIZARD_COMPLETE),
  getLastProvider: (): Promise<{ ok: boolean; data?: string; error?: string }> =>
    ipcRenderer.invoke(IPC.WIZARD_GET_LAST_PROVIDER),
  setLastProvider: (providerId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.WIZARD_SET_LAST_PROVIDER, providerId),

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
    ipcRenderer.invoke(IPC.FILE_OPEN_EXTERNAL, relPath),

  // ---------- Ollama 便携运行时 ----------
  getOllamaStatus: (): Promise<OllamaRuntimeStatus> =>
    ipcRenderer.invoke(IPC.OLLAMA_GET_STATUS),
  installOllama: (): Promise<OllamaRuntimeStatus> =>
    ipcRenderer.invoke(IPC.OLLAMA_INSTALL),
  startOllama: (): Promise<{ ok: boolean; status?: OllamaRuntimeStatus; error?: string }> =>
    ipcRenderer.invoke(IPC.OLLAMA_START),
  stopOllama: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.OLLAMA_STOP),
  listOllamaModels: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC.OLLAMA_LIST_MODELS),
  pullOllamaModel: (model: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.OLLAMA_PULL, model),
  abortOllamaPull: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.OLLAMA_PULL_ABORT),
  onOllamaInstallEvent: (handler: (e: OllamaInstallEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: OllamaInstallEvent) => handler(data)
    ipcRenderer.on(IPC.OLLAMA_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.OLLAMA_EVENT, listener)
  },
  onOllamaPullEvent: (handler: (e: OllamaPullEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: OllamaPullEvent) => handler(data)
    ipcRenderer.on(IPC.OLLAMA_PULL_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.OLLAMA_PULL_EVENT, listener)
  },
  getOllamaMirror: (): Promise<{ ok: boolean; mirror?: string }> =>
    ipcRenderer.invoke(IPC.OLLAMA_MIRROR_GET),
  setOllamaMirror: (prefix: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.OLLAMA_MIRROR_SET, prefix)
}

contextBridge.exposeInMainWorld('pocketai', api)

export type PocketAPI = typeof api
