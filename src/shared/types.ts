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
  toolCalls?: string | null
  attachments?: ChatAttachment[]
  /** 同一次生成请求的批次 ID（=requestId）；同 parent 下多个 batch 即多条分支；旧数据为 null */
  batchId?: string | null
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
  arguments?: string // 工具调用参数（JSON 字符串，用于历史回放）
  content: string // 序列化后的工具输出（JSON 字符串或纯文本）
  isError?: boolean
}

// ---------- MCP Server ----------
export type McpTransport = 'stdio' | 'http'
export type McpRuntime = 'node' | 'python' | 'binary'
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface McpServerRecord {
  id: string
  name: string
  transport: McpTransport
  runtime: 'node' | 'python' | 'binary' // stdio 解释器类型，binary=自定义可执行文件（向后兼容）
  command: string | null // stdio: 可执行文件，如 'node' / 'python' 解释器路径
  args: string[] // stdio: 参数数组
  env: Record<string, string> // stdio: 环境变量
  url: string | null // http 传输
  enabled: boolean
  createdAt: number
  /** runtime=python 时的 pip 依赖描述列表（每行一个，如 mcp-server-fetch==0.1.0）；其他 runtime 恒为 [] */
  pythonPackages: string[]
}

// ---------- Python MCP 虚拟环境 ----------
/** none=未创建；installing=安装进行中；ready=可用且依赖已装；stale=venv 失效（换盘符/换解释器/缺标记） */
export type PythonEnvStatus = 'none' | 'installing' | 'ready' | 'stale'

export interface PythonEnvState {
  serverId: string
  status: PythonEnvStatus
  /** 当前记录里声明的依赖（未清洗） */
  packages: string[]
  /** venv 解释器版本（ready/stale 但可执行时可能有值） */
  pythonVersion: string | null
  /** 所选 base 解释器路径（record.command） */
  basePython: string | null
  /** 安装标记记录的已安装依赖（ready 时有值） */
  installedPackages: string[]
}

/** Python 环境安装过程事件（venv/pip 阶段逐行输出；done/error 为终态） */
export interface PythonEnvInstallEvent {
  serverId: string
  stage: 'venv' | 'pip' | 'done' | 'error'
  /** 逐行输出内容（venv/pip 阶段） */
  line?: string
  /** 终态或阶段性说明（done/error 中文消息） */
  message?: string
  timestamp: number
}

/**
 * pip 源传输形态：
 * 'official' = https://pypi.org/simple，'tuna' = 清华镜像；
 * 其他字符串视为自定义 index URL（调用方负责 http(s) 校验）。
 */
export type PythonPipSource = 'official' | 'tuna' | (string & {})

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

// ---------- 终端命令工具（shell_exec） ----------
/** 终端命令策略：confirm=逐条确认；auto-safe=仅危险命令确认（黑名单始终硬拒） */
export type ShellPolicy = 'confirm' | 'auto-safe'

export interface ShellConfig {
  enabled: boolean
  policy: ShellPolicy
}

/** 联网搜索服务商（v2 批次六：web.search 工具） */
export type WebSearchProvider = 'tavily' | 'bocha'

export interface WebSearchConfig {
  enabled: boolean
  provider: WebSearchProvider
  /** 渲染端永远拿到空串（Key 不回显明文），是否已配置看 hasKey */
  apiKey: string
  hasKey: boolean
}

/** 本地日历（calendar.read 工具）：启停 + .ics 文件路径列表（上限 10 个） */
export interface CalendarConfig {
  enabled: boolean
  paths: string[]
}

// ---------- Channels（IM Bot 网关：Telegram/飞书/钉钉/Slack/Discord） ----------
export type ChannelType = 'telegram' | 'feishu' | 'dingtalk' | 'slack' | 'discord'
export const CHANNEL_TYPES: readonly ChannelType[] = ['telegram', 'feishu', 'dingtalk', 'slack', 'discord']

export type ChannelStatus = 'stopped' | 'starting' | 'running' | 'error'

/**
 * 网关统一配置（渲染端永远拿到空串密钥，是否已配置看 hasPrimarySecret/hasSecondarySecret）。
 *
 * 凭证字段说明：
 * - Telegram: primary = Bot Token
 * - Discord:  primary = Bot Token
 * - Slack:    primary = Bot Token (xoxb-) ; secondary = App-Level Token (xapp-, Socket Mode)
 * - 飞书:     appId = App ID（非密钥） ; secondary = App Secret
 * - 钉钉:     appId = App Key（非密钥） ; secondary = App Secret
 */
export interface ChannelConfig {
  type: ChannelType
  enabled: boolean
  /** 主凭据是否已配置（Token/App Secret/Bot Token 等） */
  hasPrimarySecret: boolean
  /** 次凭据是否已配置（Slack appToken / 飞书&钉钉 appSecret） */
  hasSecondarySecret: boolean
  /** 飞书 App ID / 钉钉 App Key（非密钥，明文存） */
  appId: string
  /** 逗号分隔的用户/群 ID 白名单（统一字符串，空=拒绝所有，fail closed） */
  whitelist: string
  /** 绑定助手（systemPrompt/技能/知识库来源） */
  assistantId: string
  /** 目标模型；为空时回退绑定助手的默认模型 */
  providerId: string
  model: string
  /** true=远程消息走 Agent ReAct（含工具调用），默认普通问答 */
  agentMode: boolean
}

export interface ChannelStatusEvent {
  type: ChannelType
  status: ChannelStatus
  lastError: string | null
}

// ---------- 沙箱（v2 批次八：沙箱基础层） ----------
export interface SandboxFileMeta {
  id: string
  name: string
  size: number
  createdAt: number
  // v2 批次九（迷你应用）：应用化元数据
  icon: string // emoji，默认 📦
  description: string // 可空
  isApp: boolean // true=迷你应用，false=普通沙箱产物
}

/** 工具调用审批请求（主进程 → 渲染端全局弹窗） */
export interface ToolApprovalRequestEvent {
  approvalId: string
  requestId: string
  conversationId: string
  toolName: string
  /** 命令全文（shell_exec）或参数 JSON 摘要（其它 confirm 工具） */
  command: string
  /** 执行目录（shell_exec 时有值） */
  cwd?: string
  /** 风险原因 code，渲染端映射 i18n：agent.approval.reason.<code> */
  reason: string
  /** confirm=需用户确认；deny 不走弹窗（保留字段以备扩展） */
  risk?: 'danger' | 'custom'
}

export interface ToolApprovalResponsePayload {
  approvalId: string
  approved: boolean
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
  attachments?: ChatAttachment[] // 图片/文档附件
}

/** 聊天附件（图片或文档） */
export interface ChatAttachment {
  type: 'image' | 'text'
  name: string
  mimeType: string
  size: number
  /** image: base64 data URL (data:image/png;base64,...) | text: 文件文本内容 */
  data: string
}

export interface RegeneratePayload {
  requestId: string
  conversationId: string
  assistantId: string | null
  messageId: string // 要重新生成的 assistant 消息 ID
  targets: ChatTarget[]
}

/** 改参重跑 / 编辑用户消息后重发：删除旧回复，用新参数重新请求 */
export interface ResendPayload {
  requestId: string
  conversationId: string
  assistantId: string | null
  messageId: string // 用户消息 ID
  content?: string // 编辑后的新内容（不传则用原内容）
  targets: ChatTarget[]
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
  quickAccelerator: string // Electron accelerator 字符串（可在设置中自定义）
  selectionAccelerator: string
}

/** 设置浮窗配置（含自定义快捷键）的返回结果；error 为机器可读错误码 */
export interface PopupSetConfigResult {
  ok: boolean
  /** occupied=快捷键被占用/无效；same=两个快捷键相同 */
  error?: 'occupied' | 'same'
  /** occupied 时注册失败的 accelerator */
  accel?: string
  config: PopupConfig
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

// ---------- 首启向导 ----------
export interface WizardState {
  /** 是否已完成过首启向导 */
  wizardDone: boolean
  /** 检测到机器指纹变化（便携盘换电脑） */
  machineChanged: boolean
  /** 当前是否运行在便携盘（可移动磁盘） */
  isPortable: boolean
}

// ---------- 平台管家：模型推荐 ----------
export interface ModelPick {
  /** Ollama 模型 tag，如 qwen2.5:7b-instruct-q4_K_M */
  id: string
  /** '首选' | '备选' | '向量' */
  tag: string
  reason: string
  /** 是否已在本机 Ollama 中安装 */
  installed: boolean
}

export interface ModelRecommendation {
  /** 档位：入门 / 主流 / 高性能 / 旗舰（含 CPU 后缀） */
  tier: string
  /** 硬件画像一句话总结 */
  summary: string
  localPicks: ModelPick[]
  /** 在线模型使用建议 */
  onlineHint: string
  ollamaRunning: boolean
  installedModels: string[]
  warnings: string[]
}

// ---------- 平台管家：安全检测 / 故障诊断 ----------
export type CheckLevel = 'ok' | 'warn' | 'danger'

export interface SecurityCheck {
  id: string
  label: string
  level: CheckLevel
  detail: string
  suggestion?: string
}

export interface AuditResult {
  /** 安全评分 0-100（danger -30 / warn -10） */
  score: number
  checks: SecurityCheck[]
}

export interface DiagnoseItem {
  id: string
  label: string
  level: CheckLevel
  detail: string
  /** 可操作的修复建议 */
  fix?: string
}

export interface DiagnoseResult {
  items: DiagnoseItem[]
}

// ---------- 笔记 ----------
export interface Note {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** Python 运行时信息（系统安装或便携版） */
export interface PythonRuntime {
  name: string
  version: string
  path: string
  source: 'system' | 'portable'
}

// ---------- Ollama 便携运行时 ----------
/** 当前 11434 服务由谁提供：portable=本平台下载的便携版；system=系统已装 Ollama */
export type OllamaSource = 'portable' | 'system'

export interface OllamaRuntimeStatus {
  /** 当前平台是否提供便携发行包（仅 Windows x64 / Linux x64） */
  platformSupported: boolean
  /** 便携版二进制是否已下载解压 */
  installed: boolean
  /** 11434 API 是否可用（不区分便携/系统） */
  running: boolean
  /** 服务来源：便携 / 系统 / null（未运行） */
  source: OllamaSource | null
  version: string | null
  /** 便携版安装目录（runtime/ollama-*） */
  installDir: string | null
  /** 模型文件目录（锚定平台 data/ollama-models，随 U 盘走） */
  modelsDir: string
  /** 发行包下载地址（UI 提示体积/手动下载用） */
  downloadUrl: string | null
  /** 发行包字节数（UI 体积提示） */
  downloadBytes: number | null
  models: string[]
}

export type OllamaInstallStage = 'download' | 'extract' | 'verify' | 'done'

export interface OllamaInstallEvent {
  stage: OllamaInstallStage
  /** 0-100；extract 阶段无法精确计量时给出 95 下限 */
  percent: number
  receivedBytes?: number
  totalBytes?: number | null
  error?: string
}

export interface OllamaPullEvent {
  model: string
  /** ollama 原始状态：pulling manifest / pulling … / verifying sha256 / success / error */
  status: string
  /** 0-100（completed/total；total 未知时为 0） */
  percent: number
  done: boolean
  error?: string
}

// ---------- 翻译模块 ----------
/** 源语言可用 auto（自动检测），目标语言不可 */
export type TranslateLang =
  | 'auto'
  | 'zh'
  | 'en'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'ru'
  | 'es'
  | 'zh-TW'

/** 翻译风格 */
export type TranslateStyle = 'standard' | 'fluent' | 'literal' | 'formal'

/** 翻译历史记录（v12 translations 表） */
export interface TranslationRecord {
  id: string
  sourceText: string
  targetText: string
  sourceLang: TranslateLang
  targetLang: Exclude<TranslateLang, 'auto'>
  style: TranslateStyle
  providerId: string
  providerName: string
  model: string
  createdAt: number
}

/** 术语表条目（v12 translation_glossary 表） */
export interface GlossaryTerm {
  id: string
  sourceTerm: string
  targetTerm: string
  createdAt: number
}

/** 渲染端发起翻译的请求载荷 */
export interface TranslateRequestPayload {
  requestId: string
  providerId: string
  model: string
  sourceLang: TranslateLang
  targetLang: Exclude<TranslateLang, 'auto'>
  style: TranslateStyle
  text: string
  /** 是否在 system 提示词中注入术语表 */
  glossaryEnabled: boolean
}

/** 主进程推给渲染端的流式译文增量 */
export interface TranslateChunkEvent {
  requestId: string
  delta: string
}

// ---------- 绘图（图像生成，v13 images 表） ----------
/** 允许的生成尺寸（OpenAI Images 兼容取值域） */
export const IMAGE_SIZES = ['512x512', '768x768', '1024x1024', '1024x1792', '1792x1024'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

/** 生成请求载荷 */
export interface ImageGeneratePayload {
  requestId: string
  providerId: string
  model: string
  prompt: string
  size: ImageSize
}

/** 图片历史记录（文件存 DATA_DIR/images/，DB 只存相对路径） */
export interface ImageRecord {
  id: string
  prompt: string
  model: string
  providerId: string
  providerName: string
  size: string
  /** 相对 DATA_DIR 的 posix 路径，如 images/2026-09/xxx.png */
  fileName: string
  bytes: number
  createdAt: number
}

/** 列表项 = 记录 + 缩略图 dataUrl（缩略图缺失时为 null） */
export interface ImageListItem extends ImageRecord {
  thumbDataUrl: string | null
}

/** 生成结果（IPC 直接返回给渲染端） */
export type ImageResult =
  | { ok: true; record: ImageRecord; durationMs: number }
  | { ok: false; aborted?: boolean; error: string }

// ---------- 侧栏模块顺序 ----------
export type SidebarModuleId =
  | 'chat'
  | 'agent'
  | 'skills'
  | 'knowledge'
  | 'files'
  | 'notes'
  | 'translate'
  | 'image'
  | 'sandbox'
  | 'steward'
  | 'settings'

/** 侧栏模块默认顺序（也是非法/缺项配置的回退值） */
export const DEFAULT_SIDEBAR_ORDER: SidebarModuleId[] = [
  'chat',
  'agent',
  'skills',
  'knowledge',
  'files',
  'notes',
  'translate',
  'image',
  'sandbox',
  'steward',
  'settings'
]

// ---------- 界面偏好（透明度 / 自定义 CSS） ----------
export interface UiPreferences {
  /** 窗口透明度 0.6–1，1 = 不透明 */
  opacity: number
  /** 渲染端注入的自定义 CSS */
  customCss: string
}

// ---------- WebDAV 增量备份 ----------
export interface IncrementalBackupResult {
  /** 增量索引文件名（pocketai-inc-*.json[.enc]） */
  filename: string
  /** 本次实际上传字节数（含 DB/新附件 blob + 索引） */
  bytesUploaded: number
  /** 新上传的 blob 数量（DB + 变化附件） */
  blobsUploaded: number
  /** 命中远端去重、跳过上传的附件数量 */
  blobsSkipped: number
  /** 附件总数 */
  attachmentsTotal: number
  encrypted: boolean
}

// ---------- 定时备份 ----------
export interface BackupRunResult {
  ok: boolean
  at: number
  filename?: string
  error?: string
}

export interface BackupScheduleStatus {
  enabled: boolean
  intervalHours: number
  lastRunAt: number | null
  lastResult: BackupRunResult | null
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
  SKILL_EXPORT: 'skill:export',
  SKILL_IMPORT: 'skill:import',
  SKILL_SYNC: 'skill:sync',
  SKILL_FETCH_INDEX: 'skill:fetch-index',
  SKILL_IMPORT_URL: 'skill:import-url',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_EXPORT: 'conversation:export',
  CONVERSATION_IMPORT: 'conversation:import',
  CONVERSATION_FORK: 'conversation:fork',

  MESSAGE_LIST: 'message:list',
  MESSAGE_DELETE: 'message:delete',
  MESSAGE_SEARCH: 'message:search',

  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_REGENERATE: 'chat:regenerate',
  CHAT_RESEND: 'chat:resend',
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

  // ---------- 笔记 ----------
  NOTES_LIST: 'notes:list',
  NOTES_GET: 'notes:get',
  NOTES_CREATE: 'notes:create',
  NOTES_UPDATE: 'notes:update',
  NOTES_DELETE: 'notes:delete',
  NOTES_SEARCH: 'notes:search',
  NOTES_CREATE_FROM_MESSAGE: 'notes:create-from-message',

  // Python 运行时
  PYTHON_RUNTIME_LIST: 'python:runtime-list',
  PYTHON_RUNTIME_DOWNLOAD: 'python:runtime-download',

  // Ollama 便携运行时（下载/解压/启动本地模型引擎）
  OLLAMA_GET_STATUS: 'ollama:get-status',
  OLLAMA_INSTALL: 'ollama:install',
  OLLAMA_EVENT: 'ollama:event',
  OLLAMA_START: 'ollama:start',
  OLLAMA_STOP: 'ollama:stop',
  OLLAMA_LIST_MODELS: 'ollama:list-models',
  OLLAMA_PULL: 'ollama:pull',
  OLLAMA_PULL_ABORT: 'ollama:pull-abort',
  OLLAMA_PULL_EVENT: 'ollama:pull-event',
  OLLAMA_MIRROR_GET: 'ollama:mirror-get',
  OLLAMA_MIRROR_SET: 'ollama:mirror-set',

  // Python MCP 虚拟环境（venv + pip）
  PYTHON_ENV_INSTALL: 'python-env:install',
  PYTHON_ENV_STATUS: 'python-env:status',
  PYTHON_ENV_EVENT: 'python-env:event',
  PYTHON_PIP_SOURCE_GET: 'python-env:pip-source-get',
  PYTHON_PIP_SOURCE_SET: 'python-env:pip-source-set',

  // 翻译
  TRANSLATE_RUN: 'translate:run',
  TRANSLATE_ABORT: 'translate:abort',
  TRANSLATE_CHUNK_EVENT: 'translate:chunk-event',
  TRANSLATION_LIST: 'translation:list',
  TRANSLATION_DELETE: 'translation:delete',
  TRANSLATION_CLEAR: 'translation:clear',
  GLOSSARY_LIST: 'glossary:list',
  GLOSSARY_SAVE: 'glossary:save',
  GLOSSARY_DELETE: 'glossary:delete',

  // 绘图（图像生成）
  IMAGES_GENERATE: 'images:generate',
  IMAGES_ABORT: 'images:abort',
  IMAGES_LIST: 'images:list',
  IMAGES_GET_FILE: 'images:get-file',
  IMAGES_DELETE: 'images:delete',
  IMAGES_SAVE_AS: 'images:save-as',

  // ---------- 沙箱（v2 批次八：沙箱基础层） ----------
  SANDBOX_LIST: 'sandbox:list',
  SANDBOX_CREATE: 'sandbox:create',
  SANDBOX_GET: 'sandbox:get',
  SANDBOX_DELETE: 'sandbox:delete',
  SANDBOX_UPDATE_META: 'sandbox:update-meta',

  // Work Agent
  AGENT_RUN: 'agent:run',
  AGENT_ABORT: 'agent:abort',
  AGENT_STEP_EVENT: 'agent:step-event',
  AGENT_CHUNK_EVENT: 'agent:chunk-event', // 流式 thought 文本增量
  AGENT_DONE_EVENT: 'agent:done-event',
  AGENT_ERROR_EVENT: 'agent:error-event',
  AGENT_GET_WORKSPACE_DIR: 'agent:get-workspace-dir',
  AGENT_PICK_WORKSPACE_DIR: 'agent:pick-workspace-dir',
  AGENT_GET_SHELL_CONFIG: 'agent:get-shell-config',
  AGENT_SET_SHELL_CONFIG: 'agent:set-shell-config',
  AGENT_GET_WEBSEARCH_CONFIG: 'agent:get-websearch-config',
  AGENT_SET_WEBSEARCH_CONFIG: 'agent:set-websearch-config',
  AGENT_GET_CALENDAR_CONFIG: 'agent:get-calendar-config',
  AGENT_SET_CALENDAR_CONFIG: 'agent:set-calendar-config',
  AGENT_PICK_ICS_FILE: 'agent:pick-ics-file',

  // ---------- License 授权（商业版） ----------
  LICENSE_ACTIVATE: 'license:activate',
  LICENSE_IMPORT_FILE: 'license:import-file',

  // ---------- 独立窗口（标签弹出） ----------
  APP_OPEN_DETACHED: 'app:open-detached',
  AGENT_TOOL_APPROVAL_EVENT: 'agent:tool-approval-event',
  AGENT_TOOL_APPROVE_RESPONSE: 'agent:tool-approve-response',

  // ---------- Channels（IM Bot 网关：Telegram/飞书/钉钉/Slack/Discord） ----------
  CHANNEL_GET_CONFIG: 'channel:get-config',
  CHANNEL_SET_CONFIG: 'channel:set-config',
  CHANNEL_START: 'channel:start',
  CHANNEL_STOP: 'channel:stop',
  CHANNEL_STATUS_EVENT: 'channel:status-event',
  CHANNEL_LIST_STATUS: 'channel:list-status',

  // ---------- 快捷浮窗（快捷问答 / 选区助手） ----------
  POPUP_HIDE: 'popup:hide',
  POPUP_GET_PAYLOAD: 'popup:get-payload',
  POPUP_GET_CONFIG: 'popup:get-config',
  POPUP_SET_CONFIG: 'popup:set-config',
  POPUP_PAYLOAD_EVENT: 'popup:payload-event',

  // ---------- 界面偏好 ----------
  UI_GET_PREFS: 'ui:get-prefs',
  UI_SET_PREFS: 'ui:set-prefs',

  // ---------- 侧栏模块顺序 ----------
  SIDEBAR_GET_ORDER: 'sidebar:get-order',
  SIDEBAR_SET_ORDER: 'sidebar:set-order',

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
  CHANGELOG_FETCH: 'changelog:fetch', // 从 GitHub Releases 拉取更新日志

  // ---------- 加密 ----------
  ENCRYPTION_GET_STATUS: 'encryption:get-status',
  ENCRYPTION_UNLOCK: 'encryption:unlock', // 主密码解锁（打开加密 DB）
  ENCRYPTION_LOCK: 'encryption:lock', // 锁定（关闭加密 DB，清密钥）
  ENCRYPTION_SET_MASTER_PASSWORD: 'encryption:set-master-password', // 首次设置密码（通过解锁窗口）
  ENCRYPTION_CHANGE_PASSWORD: 'encryption:change-password', // 密码轮换（设置页内，old → new）
  ENCRYPTION_DISABLE: 'encryption:disable', // 禁用加密（需密码验证）
  ENCRYPTION_ENABLE: 'encryption:enable', // 设置页启用加密（明文 DB → 设置主密码）
  ENCRYPTION_HAS_RECOVERY: 'encryption:has-recovery', // 是否已生成恢复密钥
  ENCRYPTION_GENERATE_RECOVERY: 'encryption:generate-recovery', // 生成/重新生成恢复密钥（返回明文码，仅一次）
  ENCRYPTION_DISABLE_RECOVERY: 'encryption:disable-recovery', // 删除恢复密钥
  ENCRYPTION_RECOVER: 'encryption:recover', // 忘记密码：恢复码 + 新密码重置
  ENCRYPTION_SAVE_RECOVERY_FILE: 'encryption:save-recovery-file', // 恢复码另存为 txt

  // ---------- 剪贴板守卫 ----------
  CLIPBOARD_COPY_SENSITIVE: 'clipboard:copy-sensitive', // 复制敏感内容（TTL 后自动清除，锁屏立即清除）

  // ---------- 首启向导 ----------
  WIZARD_GET_STATE: 'wizard:get-state', // 是否完成过向导 + 换电脑检测结果
  WIZARD_COMPLETE: 'wizard:complete', // 标记向导完成并记录当前机器指纹

  // ---------- 备份 ----------
  BACKUP_LOCAL: 'backup:local', // 本地备份（可选加密）
  BACKUP_LOCAL_ENCRYPTED: 'backup:local-encrypted', // 本地加密备份
  BACKUP_WEBDAV_TEST: 'backup:webdav-test', // 测试 WebDAV 连接
  BACKUP_WEBDAV_UPLOAD: 'backup:webdav-upload', // 上传全量备份到 WebDAV
  BACKUP_WEBDAV_UPLOAD_INCREMENTAL: 'backup:webdav-upload-incremental', // 增量备份（附件去重）
  BACKUP_WEBDAV_LIST: 'backup:webdav-list', // 列出 WebDAV 上的备份
  BACKUP_WEBDAV_RESTORE: 'backup:webdav-restore', // 从 WebDAV 恢复
  BACKUP_WEBDAV_DELETE: 'backup:webdav-delete', // 删除 WebDAV 备份
  BACKUP_WEBDAV_SAVE_CONFIG: 'backup:webdav-save-config', // 保存 WebDAV 配置
  BACKUP_WEBDAV_LOAD_CONFIG: 'backup:webdav-load-config', // 读取 WebDAV 配置
  BACKUP_SCHEDULE_GET: 'backup:schedule-get', // 读取定时备份计划
  BACKUP_SCHEDULE_SET: 'backup:schedule-set', // 保存定时备份计划

  // ---------- 隐私锁 ----------
  LOCK_GET_STATUS: 'lock:get-status',
  LOCK_LOCK: 'lock:lock',
  LOCK_UNLOCK: 'lock:unlock',
  LOCK_SET_AUTO_TIMEOUT: 'lock:set-auto-timeout',
  LOCK_MARK_ACTIVE: 'lock:mark-active',
  LOCK_STATE_EVENT: 'lock:state-event',

  // ---------- 平台管家 ----------
  HEALTH_REPORT: 'health:report',
  HEALTH_CLEANUP: 'health:cleanup',
  HEALTH_VACUUM: 'health:vacuum',
  STEWARD_MODEL_RECOMMEND: 'steward:model-recommend', // 按硬件画像推荐本地模型
  STEWARD_AUDIT: 'steward:audit', // 安全检测
  STEWARD_DIAGNOSE: 'steward:diagnose', // 故障诊断

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
