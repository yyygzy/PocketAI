// 共享类型定义（主进程 / preload / 渲染进程共用）

// ---------- 硬件信息 ----------
export interface CpuInfo {
  model: string
  cores: number
}

export interface MemoryInfo {
  total: number // bytes
  free: number // bytes
}

export interface GpuInfo {
  name: string
  memory?: number // bytes
  driver?: string // 驱动版本
  cuda: boolean
  mps: boolean
}

export interface DiskInfo {
  type: 'ssd' | 'hdd' | 'usb' | 'unknown'
  removable: boolean
  drive: string | null // 盘符，如 'C:'
  volumeLabel: string | null
  filesystem: string | null
  totalSpace: number | null // bytes
  freeSpace: number | null // bytes
  mediumType: string | null // 'SSD' | 'HDD'
  busType: string | null // 'NVMe' | 'SATA' | 'USB' | ...
}

export interface OsInfo {
  platform: string
  release: string
  arch: string
  hostname?: string
}

export interface HardwareInfo {
  cpu: CpuInfo
  memory: MemoryInfo
  gpus: GpuInfo[]
  disk: DiskInfo
  os: OsInfo
}

export interface AppPaths {
  appRoot: string
  dataDir: string
  dbPath: string
  configPath: string
  attachmentsDir: string
  extensionsDir: string
}

// ---------- Provider ----------
export type ProviderType = 'openai-compatible' | 'ollama' | 'gemini' | 'anthropic'

export interface ProviderRecord {
  id: string
  type: ProviderType
  name: string
  baseUrl: string
  apiKeys: string[] // 多 Key 轮询（Phase 1 明文，Phase 4 字段级加密）
  models: string[] // 已缓存的模型 ID
  enabled: boolean
  createdAt: number
}

export interface ModelOption {
  id: string
  name: string
}

// ---------- 会话 / 消息 ----------
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'
export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted'

export interface AssistantRecord {
  id: string
  name: string
  description: string
  avatar: string
  systemPrompt: string
  defaultProviderId: string | null
  defaultModel: string | null
  defaultParams: Record<string, unknown> | null
  toolPermissions: string[]
  skillIds: string[]
  knowledgeBaseIds: string[]
  welcomeMessage: string
  isBuiltin: boolean
  isPinned: boolean
  createdAt: number
}

// ---------- 技能（可复用提示词片段） ----------
export interface SkillRecord {
  id: string
  name: string
  description: string
  icon: string // emoji
  content: string // 注入 SystemPrompt 的提示词片段
  enabled: boolean
  isBuiltin: boolean
  createdAt: number
}

export interface ConversationRecord {
  id: string
  assistantId: string | null
  title: string
  modelLabel: string | null // 形如 "providerId:model"
  status: string
  createdAt: number
  updatedAt: number
}

export interface MessageRecord {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  provider: string | null
  model: string | null
  status: MessageStatus
  parentId: string | null
  createdAt: number
}

// ---------- 知识库 ----------
export type KbDocStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'error'
export type KbSourceType = 'pdf' | 'docx' | 'xlsx' | 'html' | 'url' | 'txt' | 'md'

export interface KnowledgeBase {
  id: string
  name: string
  description: string
  embeddingProviderId: string | null
  embeddingModel: string | null
  embeddingDim: number | null
  chunkSize: number
  chunkOverlap: number
  topK: number
  topN: number
  documentCount: number
  chunkCount: number
  createdAt: number
}

export interface KbDocument {
  id: string
  kbId: string
  source: string
  sourceType: KbSourceType
  title: string
  chunkCount: number
  status: KbDocStatus
  error: string | null
  createdAt: number
}

export interface KbChunk {
  id: string
  docId: string
  kbId: string
  sequence: number
  content: string
  createdAt: number
}

export interface RetrievedChunk {
  chunkId: string
  docId: string
  docTitle: string
  content: string
  score: number
}

export interface RetrievalResult {
  query: string
  chunks: RetrievedChunk[]
}

// ---------- 工具 / Function Calling ----------
export interface ToolSchema {
  id: string // 唯一标识，如 'web.fetch' 或 'mcp:<serverId>:<toolName>'
  name: string // 给 LLM 看的函数名（必须符合 ^[a-zA-Z][a-zA-Z0-9_]*$）
  description: string
  parameters: Record<string, unknown> // JSON Schema（宽松类型，避免引入 json-schema 依赖）
  source: 'builtin' | 'mcp'
  permission?: 'auto' | 'confirm' | 'deny'
  mcpServerId?: string // source='mcp' 时所属的 MCP Server
}

export interface ToolCall {
  id: string // LLM 生成的调用 ID
  type: 'function'
  function: { name: string; arguments: string } // arguments 为 JSON 字符串
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string // 序列化后的工具输出（JSON 字符串或纯文本）
  isError?: boolean
}

// ---------- MCP Server ----------
export type McpTransport = 'stdio' | 'http'
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface McpServerRecord {
  id: string
  name: string
  transport: McpTransport
  command: string | null // stdio: 可执行文件，如 'node'
  args: string[] // stdio: 参数数组
  env: Record<string, string> // stdio: 环境变量
  url: string | null // http 传输
  enabled: boolean
  createdAt: number
}

/** 运行时状态（不持久化，由 manager 维护并随事件推送） */
export interface McpServerRuntime extends McpServerRecord {
  status: McpServerStatus
  tools: ToolSchema[]
  lastError: string | null
  pid?: number
}

export interface McpServerStatusEvent {
  serverId: string
  status: McpServerStatus
  tools?: ToolSchema[]
  lastError?: string | null
  pid?: number
}

export interface McpServerLogEvent {
  serverId: string
  stream: 'stdout' | 'stderr'
  line: string
  timestamp: number
}

// ---------- Work Agent ----------
export type AgentStepType = 'thought' | 'tool_call' | 'tool_result' | 'final' | 'error'

export interface AgentStepEvent {
  requestId: string
  conversationId: string
  stepIndex: number
  type: AgentStepType
  text?: string // thought/final 的文本
  toolCall?: ToolCall // tool_call 步骤
  toolResult?: ToolResult // tool_result 步骤
  error?: string
  messageId?: string // 持久化到 DB 的消息 ID（assistant/tool 消息）
  done?: boolean // 是否为最后一步
}

export interface AgentDoneEvent {
  requestId: string
  conversationId: string
  finalMessageId: string
  fullContent: string
  stepCount: number
}

export interface AgentErrorEvent {
  requestId: string
  conversationId: string
  error: string
}

// ---------- 发送请求 ----------
export interface ChatTarget {
  providerId: string
  model: string
}

export interface SendMessagePayload {
  requestId: string
  conversationId: string
  assistantId: string | null
  content: string
  targets: ChatTarget[] // 1 个=单模型；多个=一问多答并行对照
  agentMode?: boolean // true=走 Work Agent ReAct 循环；false/省略=普通对话
}

export interface ChatChunkEvent {
  requestId: string
  targetIndex: number
  messageId: string
  delta: string
}

export interface ChatDoneEvent {
  requestId: string
  targetIndex: number
  messageId: string
  fullContent: string
}

export interface ChatErrorEvent {
  requestId: string
  targetIndex: number
  messageId: string
  error: string
}

// ---------- 快捷浮窗 ----------
export type PopupMode = 'quick' | 'selection'

export interface PopupPayload {
  mode: PopupMode
  text?: string // selection 模式下取到的选中文本
  ts: number
}

export interface PopupConfig {
  quickEnabled: boolean
  selectionEnabled: boolean
  quickAccelerator: string // 仅展示用（当前版本固定）
  selectionAccelerator: string
}

// ---------- License 授权 ----------
export type LicensePlan = 'free' | 'pro' | 'enterprise'

export interface LicensePayload {
  version: number
  license_id: string
  owner: string
  issued_at: number
  expires_at: number
  plan: LicensePlan
  features: string[]
}

export interface LicenseStatus {
  valid: boolean
  payload?: LicensePayload
  error?: string
  signatureOk: boolean
  expired: boolean
  hasFeature: (feature: string) => boolean
}

// ---------- 自动更新 ----------
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'unavailable' | 'downloading' | 'downloaded' | 'error'

export interface UpdateInfo {
  /** package.json version */
  currentVersion: string
  /** 是否为 electron-builder 打包版本（dev 环境返回 false） */
  isPackaged: boolean
  /** 是否为 portable 格式（非 NSIS installer） */
  isPortable: boolean
}

export interface UpdateEvent {
  status: UpdateStatus
  /** 新版本号（available/downloading/downloaded 时有值） */
  newVersion?: string
  /** 下载进度 0-100（downloading 时有值） */
  progress?: number
  /** 下载总字节 */
  totalBytes?: number
  /** 已下载字节 */
  downloadedBytes?: number
  /** 错误信息 */
  error?: string
}

// ---------- 加密 ----------
export type EncryptionMode = 'none' | 'db' | 'field'

export interface EncryptionStatus {
  mode: EncryptionMode
  unlocked: boolean
  /** DB 是否已加密（sqlcipher 开启） */
  dbEncrypted: boolean
  /** 字段级加密是否启用 */
  fieldEncrypted: boolean
  /** 当前主密码是否已验证通过（解锁状态） */
  masterPasswordVerified: boolean
}

export interface UnlockPayload {
  /** 用户输入的主密码（空字符串=无密码模式） */
  password: string
}

// ---------- 隐私锁 ----------
export type LockState = 'unlocked' | 'locked'

export interface LockStatus {
  state: LockState
  /** 上次解锁时间（ms） */
  lastUnlockedAt: number
  /** 自动锁屏超时（ms），0=永不自动锁 */
  autoLockTimeout: number
}

export interface LockStateEvent {
  state: LockState
  reason: 'manual' | 'auto-timeout' | 'app-hidden' | 'os-sleep'
}

// ---------- 平台管家 ----------
export interface HealthReport {
  dbIntegrity: { ok: boolean; details: string }
  orphanMessages: number
  orphanChunks: number
  kbCount: number
  totalMessages: number
  totalConversations: number
  totalAttachmentsBytes: number
}

export interface CleanupResult {
  removedOrphanMessages: number
  removedOrphanChunks: number
  vacuumedBytes: number
}

// ---------- 文件模块（数据目录文件管理器） ----------
export interface FileEntry {
  name: string
  relPath: string // 相对 DATA_DIR 的路径，'/' 分隔
  isDir: boolean
  size: number // bytes（目录为 0）
  mtime: number // ms
}

export interface FileReadResult {
  ok: boolean
  /** text: 截断后的 utf8 文本；image: base64 data URL；binary: null */
  kind: 'text' | 'image' | 'binary'
  content: string | null
  size: number
  truncated: boolean
  mime?: string
}

export interface FileOpResult {
  ok: boolean
  error?: string
}

// ---------- IPC 通道 ----------
export const IPC = {
  SYSTEM_HARDWARE_INFO: 'system:hardware-info',
  APP_GET_PATHS: 'app:get-paths',
  MENU_SET_LANGUAGE: 'menu:set-language',
  UPDATE_SET_SETTINGS: 'update:set-settings',
  DB_RUN_MIGRATIONS: 'db:run-migrations',
  DB_INTEGRITY_CHECK: 'db:integrity-check',

  PROVIDER_LIST: 'provider:list',
  PROVIDER_SAVE: 'provider:save',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_FETCH_MODELS: 'provider:fetch-models',
  PROVIDER_TEST: 'provider:test',

  ASSISTANT_LIST: 'assistant:list',
  ASSISTANT_GET: 'assistant:get',
  ASSISTANT_SAVE: 'assistant:save',
  ASSISTANT_DELETE: 'assistant:delete',
  ASSISTANT_DUPLICATE: 'assistant:duplicate',
  ASSISTANT_SET_PINNED: 'assistant:set-pinned',

  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_EXPORT: 'conversation:export',
  CONVERSATION_IMPORT: 'conversation:import',

  MESSAGE_LIST: 'message:list',
  MESSAGE_SEARCH: 'message:search',

  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_CHUNK_EVENT: 'chat:chunk-event',
  CHAT_DONE_EVENT: 'chat:done-event',
  CHAT_ERROR_EVENT: 'chat:error-event',

  KB_LIST: 'kb:list',
  KB_GET: 'kb:get',
  KB_SAVE: 'kb:save',
  KB_DELETE: 'kb:delete',

  KB_DOC_LIST: 'kb-doc:list',
  KB_DOC_ADD_FILE: 'kb-doc:add-file',
  KB_DOC_ADD_URL: 'kb-doc:add-url',
  KB_DOC_ADD_TEXT: 'kb-doc:add-text',
  KB_DOC_DELETE: 'kb-doc:delete',
  KB_DOC_REINDEX: 'kb-doc:reindex',

  KB_CHUNK_LIST: 'kb-chunk:list',
  KB_RETRIEVE: 'kb:retrieve',

  // MCP Server
  MCP_SERVER_LIST: 'mcp-server:list',
  MCP_SERVER_GET: 'mcp-server:get',
  MCP_SERVER_SAVE: 'mcp-server:save',
  MCP_SERVER_DELETE: 'mcp-server:delete',
  MCP_SERVER_START: 'mcp-server:start',
  MCP_SERVER_STOP: 'mcp-server:stop',
  MCP_SERVER_RESTART: 'mcp-server:restart',
  MCP_SERVER_LIST_TOOLS: 'mcp-server:list-tools',
  MCP_SERVER_GET_RUNTIMES: 'mcp-server:get-runtimes', // 一次性拉取所有运行时状态
  MCP_SERVER_STATUS_EVENT: 'mcp-server:status-event',
  MCP_SERVER_LOG_EVENT: 'mcp-server:log-event',

  // Work Agent
  AGENT_RUN: 'agent:run',
  AGENT_ABORT: 'agent:abort',
  AGENT_STEP_EVENT: 'agent:step-event',
  AGENT_CHUNK_EVENT: 'agent:chunk-event', // 流式 thought 文本增量
  AGENT_DONE_EVENT: 'agent:done-event',
  AGENT_ERROR_EVENT: 'agent:error-event',
  AGENT_GET_WORKSPACE_DIR: 'agent:get-workspace-dir',
  AGENT_PICK_WORKSPACE_DIR: 'agent:pick-workspace-dir',

  // ---------- 快捷浮窗（快捷问答 / 选区助手） ----------
  POPUP_HIDE: 'popup:hide',
  POPUP_GET_PAYLOAD: 'popup:get-payload',
  POPUP_GET_CONFIG: 'popup:get-config',
  POPUP_SET_CONFIG: 'popup:set-config',
  POPUP_PAYLOAD_EVENT: 'popup:payload-event',

  // 工具（只读）
  TOOL_LIST_AVAILABLE: 'tool:list-available', // 列出所有可用工具（按助手机器权限可在外层过滤）

  // ---------- License 授权 ----------
  LICENSE_GET_STATUS: 'license:get-status',
  LICENSE_LOAD_FILE: 'license:load-file', // 传入 license.lic 文件路径
  LICENSE_LOAD_STRING: 'license:load-string', // 传入 license 字符串
  LICENSE_CLEAR: 'license:clear',
  LICENSE_HAS_FEATURE: 'license:has-feature',

  // ---------- 自动更新 ----------
  UPDATE_GET_INFO: 'update:get-info', // 返回当前版本 + build 类型
  UPDATE_CHECK: 'update:check', // 检查远程版本
  UPDATE_DOWNLOAD: 'update:download', // 下载已发现的更新
  UPDATE_QUIT_INSTALL: 'update:quit-install', // 退出并安装
  UPDATE_EVENT: 'update:event', // 主进程推送事件到渲染

  // ---------- 加密 ----------
  ENCRYPTION_GET_STATUS: 'encryption:get-status',
  ENCRYPTION_UNLOCK: 'encryption:unlock', // 主密码解锁（打开加密 DB）
  ENCRYPTION_LOCK: 'encryption:lock', // 锁定（关闭加密 DB，清密钥）
  ENCRYPTION_SET_MASTER_PASSWORD: 'encryption:set-master-password', // 首次设置密码（通过解锁窗口）
  ENCRYPTION_CHANGE_PASSWORD: 'encryption:change-password', // 密码轮换（设置页内，old → new）
  ENCRYPTION_DISABLE: 'encryption:disable', // 禁用加密（需密码验证）
  ENCRYPTION_ENABLE: 'encryption:enable', // 设置页启用加密（明文 DB → 设置主密码）

  // ---------- 备份 ----------
  BACKUP_LOCAL: 'backup:local', // 本地备份（可选加密）
  BACKUP_LOCAL_ENCRYPTED: 'backup:local-encrypted', // 本地加密备份
  BACKUP_WEBDAV_TEST: 'backup:webdav-test', // 测试 WebDAV 连接
  BACKUP_WEBDAV_UPLOAD: 'backup:webdav-upload', // 上传备份到 WebDAV
  BACKUP_WEBDAV_LIST: 'backup:webdav-list', // 列出 WebDAV 上的备份
  BACKUP_WEBDAV_RESTORE: 'backup:webdav-restore', // 从 WebDAV 恢复
  BACKUP_WEBDAV_DELETE: 'backup:webdav-delete', // 删除 WebDAV 备份
  BACKUP_WEBDAV_SAVE_CONFIG: 'backup:webdav-save-config', // 保存 WebDAV 配置
  BACKUP_WEBDAV_LOAD_CONFIG: 'backup:webdav-load-config', // 读取 WebDAV 配置

  // ---------- 隐私锁 ----------
  LOCK_GET_STATUS: 'lock:get-status',
  LOCK_LOCK: 'lock:lock',
  LOCK_UNLOCK: 'lock:unlock',
  LOCK_SET_AUTO_TIMEOUT: 'lock:set-auto-timeout',
  LOCK_STATE_EVENT: 'lock:state-event',

  // ---------- 平台管家 ----------
  HEALTH_REPORT: 'health:report',
  HEALTH_CLEANUP: 'health:cleanup',
  HEALTH_VACUUM: 'health:vacuum',

  // ---------- 文件模块 ----------
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',
  FILE_UPLOAD: 'file:upload',
  FILE_MKDIR: 'file:mkdir',
  FILE_DELETE: 'file:delete',
  FILE_SAVE_AS: 'file:save-as',
  FILE_OPEN_LOCATION: 'file:open-location',
  FILE_OPEN_EXTERNAL: 'file:open-external'
} as const
