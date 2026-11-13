// 共享类型定义（主进程 / preload / 渲染进程共用）
import type {
  ModelOnlineHintCode,
  ModelPickTagCode,
  ModelReasonCode,
  ModelSummaryCode,
  ModelTierCode,
  ModelWarnCode
} from './model-rec-codes'
import type { ExternalDroppedMessages, ExternalWarning } from './conversation-import-external'
import type { ToolPolicyReasonCode } from './tool-policy-reasons'

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
  /**
   * 实占显存（bytes）。只有 NVIDIA 且 nvidia-smi 在场时取得到；其他平台/无驱动为 undefined。
   * Mac 的统一内存不是显存，故意留空而不填估算值（V4-Iter-140）。
   */
  usedMemory?: number
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
  /** 仅内置助手在列表返回时填充：是否已被「启用」进我的助手列表 */
  enabled?: boolean
}

/** ASSISTANT_LIST 的取数口径：all=全量（默认，行为不变）；mine=自建＋已启用的内置；market=仅内置 */
export type AssistantListScope = 'all' | 'mine' | 'market'

/** 复制助手的返回：附带被丢弃的失效技能/知识库引用数（仅 duplicate 通道返回） */
export type DuplicatedAssistant = AssistantRecord & {
  droppedSkills: number
  droppedKb: number
}

// ---------- 技能（可复用提示词片段） ----------
export interface SkillRecord {
  id: string
  name: string
  description: string
  icon: string // emoji
  content: string // 注入 SystemPrompt 的提示词片段
  /** 作者写的自由文本分类；'' = 未写（老库/老导出文件读出来也是空串） */
  category: string
  /** 作者写的自由文本标签；[] = 未写（老库/老导出文件读出来也是空数组） */
  tags: string[]
  /** §236：true=正文常驻 system prompt（老行为）；false=只留名字与用途，正文靠 load_skill 按需取 */
  resident: boolean
  enabled: boolean
  isBuiltin: boolean
  createdAt: number
}

// ---------- 用户记忆（长期记忆条目） ----------
/** 记忆写入者：user=设置页手写；agent=Agent 经 memory_save 写入；legacy=v65 之前无法回溯的历史行 */
export type UserMemorySource = 'user' | 'agent' | 'legacy'

export interface UserMemoryRecord {
  id: string
  content: string
  source: UserMemorySource
  /** Agent 写入时所在的会话；用户手写或历史行为 null */
  conversationId: string | null
  /** 软删除时间（毫秒）；null=未删除。物理删除只留给明确的清理动作 */
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

/** CONVERSATION_SET_ASSISTANT 入参（改归属助手；null=自由会话。分组按助手过滤，移动会清组） */
export interface ConversationSetAssistantPayload {
  id: string
  assistantId: string | null
}

export interface ConversationRecord {
  id: string
  assistantId: string | null
  title: string
  modelLabel: string | null // 形如 "providerId:model"
  /**
   * D7：`conversations.status` 是**历史列，已停写**。v60 起运行态的唯一事实源是
   * runtime-registry + `conversation_runs`，侧栏与对话页一律读 `ChatRuntimeStateEvent`（B-2）。
   * 这里保留字段只为读老数据时兼容透传（列表/详情/导出），**任何判断都不得读它**。
   */
  status: string
  createdAt: number
  updatedAt: number
  /** 置顶（列表排序权重，组内仍按更新时间） */
  pinned: boolean
  /** 已归档（主列表隐藏，归档区可找回） */
  archived: boolean
  /** 归档时间戳；未归档为 null */
  archivedAt?: number | null
  /** 标题仍是系统占位（首轮消息可自动命名）；手动改名/自动命名完成后为 false */
  titleDefault: boolean
  /** 列表预览：最新一条消息内容截断（仅 list 查询带出，80 字符内；无消息为 null） */
  lastMessagePreview?: string | null
  /** 列表预览：该会话有未发送草稿（仅 list 查询带出） */
  hasDraft?: boolean
  /** 所属分组文件夹 id；null=未分组（顶层平铺） */
  groupId?: string | null
  /** v38：会话备注；null=无备注 */
  note?: string | null
  /** v39：会话级系统提示词覆盖；null=使用助手默认 */
  systemPromptOverride?: string | null
  /**
   * v48：子代理会话的父会话 id（决策②：子代理用独立会话）。
   * null = 用户自己的会话；非 null 时这条会话是某次委派开出来的。
   */
  parentConversationId?: string | null
  /** v48：这条会话承担的角色（归会话不归 trace——独立会话意味着一会话一角色）；null=无角色 */
  roleKey?: string | null
  /**
   * v57：本会话的 Agent 模式开关（P0-4b-1）。
   * 落库记忆：重启与切会话都按各自会话行恢复。缺省/false＝关闭——包括迁移前的老会话
   * （列是 `NOT NULL DEFAULT 0`，不用 NULL 表达"没设置"）。
   */
  agentMode?: boolean
}

/** 会话分组文件夹（按助手维度归集） */
export interface ConversationGroupRecord {
  id: string
  assistantId: string | null
  name: string
  createdAt: number
}

/** 窗口行为设置：开机自启（仅打包版生效）/ 关窗最小化到托盘 */
export interface WindowBehaviorSettings {
  launchAtLogin: boolean
  closeToTray: boolean
  /** setLoginItemSettings 是否实际被调用（dev 环境为 false） */
  launchAtLoginApplied: boolean
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
  /** 知识库引用来源（RAG 检索命中的 chunk 元信息） */
  sources?: MessageSource[] | null
  /**
   * 本轮知识库检索事实（异步落库时与 sources 同一 envelope 存进 sources 列，不新增列）。
   * 旧消息没有该字段＝没有记录过，界面上不做任何推断。
   */
  retrieval?: MessageRetrieval | null
  /** token 用量（provider 返回，assistant 消息记录；旧数据为 null） */
  usage?: UsageStats | null
  /** 引用回复：本条消息引用的同会话另一条消息 id（user 消息记录；未引用为 null） */
  replyToId?: string | null
  /** 收藏星标：用户标记的重要消息（旧数据为 false） */
  starred?: boolean
  /** 会话内置顶：顶部横幅展示（旧数据为 false） */
  pinned?: boolean
}

/** 收藏列表项（精简结构，侧边栏收藏视图预览用；按 createdAt 倒序） */
export interface StarredMessageItem {
  id: string
  conversationId: string
  /** 所属会话标题；会话已删除时为空串 */
  conversationTitle: string
  role: MessageRole
  content: string
  createdAt: number
}

/** 单次生成的 token 用量（provider 流式末尾返回的 usage） */
export interface UsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 命中缓存的输入 token 数（Anthropic cache_read / OpenAI cached_tokens） */
  cachedTokens?: number
}

/** 用量聚合汇总（按时间范围过滤） */
export interface UsageSummary {
  days: number
  totals: {
    requests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens: number
    /** 按本地配置单价估算的总费用（币种见 UsagePricing.currency；未配单价的模型计 0） */
    cost: number
  }
  daily: { date: string; totalTokens: number; cost: number }[]
  byProvider: { provider: string; requests: number; totalTokens: number; cost: number }[]
  byModel: { provider: string; model: string; requests: number; totalTokens: number; cost: number }[]
}

/** 单个模型的单价（每 100 万 token，币种由 UsagePricing.currency 统一表示） */
export interface ModelPrice {
  /** 未命中缓存的输入 token 单价 */
  input: number
  /** 输出 token 单价 */
  output: number
  /** 命中缓存的输入 token 单价；省略时按输入价计 */
  cache?: number
}

/** 用量计价配置（本地 KV，不上传） */
export interface UsagePricing {
  currency: 'CNY' | 'USD'
  /** key = `${providerId}::${model}` */
  prices: Record<string, ModelPrice>
}

/** 会话维度用量排行项（UsagePanel 会话排行区块） */
export interface UsageConversationItem {
  conversationId: string
  /** 会话已删除/无记录时的标题兜底占位 */
  title: string
  requests: number
  totalTokens: number
  cost: number
  /** 该会话最近一次计费生成时间 */
  lastUsedAt: number
}

/** 助手维度用量排行项（UsagePanel 助手排行区块） */
export interface UsageAssistantItem {
  assistantId: string
  /** 助手已删除/无记录时的名称兜底占位 */
  name: string
  requests: number
  totalTokens: number
  cost: number
  /** 该助手最近一次计费生成时间 */
  lastUsedAt: number
}

/** 历史出现过的模型（单价编辑器清单项，覆盖全部时间） */
export interface UsageModelItem {
  provider: string
  model: string
  lastUsedAt: number
}

/** 用量行级明细项（CSV 导出，每轮 assistant 生成一行；按 createdAt 倒序） */
export interface UsageDetailItem {
  createdAt: number
  /** 消息 id（明细弹窗点击跳回会话内该条消息用） */
  messageId: string
  conversationId: string
  /** JOIN 不到会话标题时的兜底占位 */
  conversationTitle: string
  /** 自由会话（无助手）或助手已删除时为 null */
  assistantId: string | null
  assistantName: string | null
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  /**
   * 该轮估算费用。
   * `null`＝这条 provider/model 没配单价（**算不出**，不是 0）；CSV 导出留空，界面显示「—」。
   * 数值（含 0）＝确实按单价算出的结果。
   */
  cost: number | null
}

/** 行级明细查询结果（超出 limit 时 truncated=true） */
export interface UsageDetailResult {
  items: UsageDetailItem[]
  truncated: boolean
}

/** 用量预算状态：daily/monthly 为预算上限（null=不限制），todayCost/monthCost 为已花估算费用 */
export interface UsageBudgetStatus {
  daily: number | null
  monthly: number | null
  todayCost: number
  monthCost: number
  /** 达到上限是否自动停发（硬阻断开关） */
  hardBlock: boolean
  /** 达到上限 80% 是否 toast 软预警（默认开） */
  warn: boolean
}

/** 预算 80% 软预警事件（同一周期只发一次；纯阈值判定结果，不含展示口径） */
export interface BudgetWarnEvent {
  scope: 'daily' | 'monthly'
  /** 当前周期已花估算费用 */
  cost: number
  /** 预算上限 */
  limit: number
  /** cost/limit（0~1+，保留 4 位） */
  ratio: number
}

/**
 * 软预警的**广播**载荷（USAGE_BUDGET_WARNING_EVENT）：在阈值事件上补上这组金额所用的币种。
 * 符号必须跟着它走——渲染端文案里再写死 ¥，用户在设置里换成 USD 后就会读到「$金额」配「¥」的错配。
 */
export interface BudgetWarnBroadcastEvent extends BudgetWarnEvent {
  currency: UsagePricing['currency']
}

/**
 * 金额预算触顶后 Agent 循环收尾的广播载荷（USAGE_BUDGET_STOP_EVENT）。
 * 只在"本轮不再发起新的 LLM 调用、写固定收尾文案"时发一次；与 80% 软预警是两条独立的广播。
 */
export interface BudgetStopBroadcastEvent {
  scope: 'daily' | 'monthly'
  cost: number
  limit: number
  currency: UsagePricing['currency']
}

/** KB 数据健康：缺向量/维度不匹配文档（需重建索引） */
export interface KbBrokenDoc {
  id: string
  kbId: string
  kbName: string
  title: string
  /** missing-vec = 有 embedding 无向量索引（vec 库丢了）；dim-mismatch = 向量维度与知识库配置不一致（换模型未重建） */
  reason: 'missing-vec' | 'dim-mismatch'
}

/** KB 数据健康：重复文档组（同库同内容 hash） */
export interface KbDuplicateGroup {
  kbId: string
  kbName: string
  hash: string
  /** 同组文档，创建时间升序（最早在前，去重保留它） */
  docs: { id: string; title: string; createdAt: number }[]
}

/** 知识库 provider 引用角色（与 kb-health.ts 的 refs 清单同源） */
export type KbProviderRole = 'embedding' | 'rerank' | 'hyde' | 'multiquery' | 'ocr'

/** KB 数据健康：知识库配置的 provider 引用失效 */
export interface KbProviderIssue {
  kbId: string
  kbName: string
  /** 引用角色 */
  role: KbProviderRole
  /** missing = provider 已删除；disabled = 已禁用；model-missing = 模型不在该 provider 模型列表 */
  issue: 'missing' | 'disabled' | 'model-missing'
}

/** KB 数据健康：完整性探测结果（只读探测 + 可修复项，见 src/main/knowledge/kb-health.ts） */
export interface KbIntegrityReport {
  /** 孤儿向量：kb_vec_map 中 chunk 已不存在的残留行（删文档历史泄漏） */
  orphanVectors: number
  /** 孤儿 chunk：kb_chunks 中所属文档已不存在的残留行 */
  orphanChunks: number
  /** 缺向量/维度不匹配文档（一键重建索引可修） */
  brokenDocs: KbBrokenDoc[]
  /** 重复文档组（保留最早删其余） */
  duplicates: KbDuplicateGroup[]
  /** provider 引用失效清单（不阻断检索，阻断入库/重索引与对应增强能力） */
  providerIssues: KbProviderIssue[]
}

/** 数据健康度报告（Settings「数据健康」面板）：数据体量 / 知识库索引状态 / 备份与维护任务 */
export interface DataHealthReport {
  /**
   * 体量明细（字节）。`userDataBytes` 是**面板上那颗「合计」**：不含浏览器档案树。
   *
   * 为什么要把 `userdata/` + `session/` 摘出去：那是 Electron 自己的 Chromium 档案树
   * （Cache/Code Cache/GPUCache/blob_storage…），本机实测 21,103 个文件 / 801 MB，
   * 而真正的用户数据资产只有几 MB——它们既让"合计"读起来不像"我的数据有多大"，
   * 也是这份报告 cold 2,334ms / warm 592ms 的全部来源（递归 stat 那两棵树 569ms）。
   * 单列一格如实显示，但**不进合计**；面板按「刷新」才会重算那一格（台账 V4-Iter-177）。
   */
  sizes: {
    userDataBytes: number
    dbBytes: number
    attachmentsBytes: number
    extensionsBytes: number
    logsBytes: number
    /** 工具输出卸载文件（`agent-tool-outputs/`）：字节 + 正式 `.txt` 条数（`.part` 只算字节） */
    coldOffloadBytes: number
    coldOffloadFiles: number
    /** 写入快照（`agent-file-snapshots/`）：字节 + 正式 `.json` 份数 */
    coldSnapshotBytes: number
    coldSnapshotFiles: number
    otherBytes: number
    browserCacheBytes: number
    browserCacheFiles: number
  }
  /** 审批审计账本（`approval_events`）：行数 + 本次进程内写失败次数 */
  approvals: { rows: number; writeFailures: number }
  /** 知识库文档索引状态 + 失败文档清单（最多 10 条，创建时间倒序） */
  kb: {
    total: number
    errorDocs: { id: string; kbName: string; title: string; error: string | null; createdAt: number }[]
    /** 完整性探测（KB 数据健康，见 src/main/knowledge/kb-health.ts） */
    integrity: KbIntegrityReport
    /** 向量索引真实规模（在主库里，不是独立文件）；dims >1 表示混用过不同 embedding 模型 */
    vectorIndex: { count: number; dims: number[] }
  }
  /** WebDAV 云备份状态 */
  backup: {
    configured: boolean
    /**
     * §382：`configured` 只说「这一栏有东西」——口令用当前主密码解不开时它照样是 true，
     * 而那意味着下一次备份必在鉴权那一步失败。三档要分开摆：没配过／配了但用不了／配了且能用。
     */
    passwordUndecryptable: boolean
    /**
     * §386：app_config 里那一行**存在**却解析不出来（多半是被旧备份整表覆盖过）。
     * 它与 `configured:false` 不是一回事：后者说"你还没配"，前者说"你配过、而本机读不出那份配置"——
     * 处置方式也不同（重填并保存 vs 从头配置）。改前这一档塌进 `configured:false`，
     * 于是设置页摆一张空表单，点「保存」正好把那份坏行覆盖掉。
     */
    configUnreadable: boolean
    enabled: boolean
    intervalHours: number
    lastRunAt: number | null
    lastOkAt: number | null
    lastError: string | null
  }
  /** 内置维护任务（task-scheduler）上次运行时间
   *  §395：`lastOk` 是三档（true 成功／false 失败／null 还没记过），不是布尔——
   *        时间戳只能说明「跑过」，屏上那句必须跟着这一档走，不许把 null 画成成功 */
  tasks: {
    kbHealthCheckLastRunAt: number | null
    kbHealthCheckLastOk: boolean | null
    backupVerifyLastRunAt: number | null
    backupVerifyLastOk: boolean | null
  }
}

/** 运行期慢事件 */
export interface PerfEvent {
  /** 事件标签（≤64 字符） */
  label: string
  /** 耗时毫秒 */
  ms: number
  /** 可选附加信息 */
  detail?: string
  /** 事件产生时刻时间戳 */
  at: number
}

/** MCP 调用来源：Agent 循环，还是用户在 MCP 面板点「试运行」 */
export type McpCallSource = 'agent' | 'manual'

/** MCP 工具调用记录（落库，跨重启可查；预览字段写入前已脱敏+截断） */
export interface McpCallLogRecord {
  id: number
  serverId: string
  tool: string
  /** 这次调用是谁发起的（v62 起落库；更早的历史行统一按 agent 读） */
  source: McpCallSource
  /** 调用是否成功（server 返回业务级错误也算失败） */
  ok: boolean
  durationMs: number
  /** 入参预览（敏感键名替换 + 截断）；无入参时为 null */
  argsPreview: string | null
  /** 结果预览（截断）；失败时为 null */
  resultPreview: string | null
  /** 失败原因（成功为 null） */
  error: string | null
  createdAt: number
}

/** mcpManager 发出的调用事件（字段与落库记录同源，id/createdAt 由主进程补） */
export interface McpCallEvent {
  serverId: string
  tool: string
  /** 来源：Agent 循环（默认）或面板手工试运行 */
  source: McpCallSource
  ok: boolean
  durationMs: number
  argsPreview: string | null
  resultPreview: string | null
  error: string | null
}
/** RAG 检索命中的知识库 chunk 引用来源；联网搜索/网页抓取来源复用同一结构 */
export interface MessageSource {
  chunkId: string
  docId: string
  docTitle: string
  content: string
  /** 所属知识库 id（旧数据无此字段，不可跳转原文） */
  kbId?: string
  /** 分块序号（旧数据无此字段，不可跳转原文） */
  seq?: number
  /** 网页来源的可点链接（仅 kind='web'；知识库来源不带） */
  url?: string
  /** 来源类型：缺省＝旧知识库来源（与迁移前落库数据同一口径）；web＝联网搜索/网页抓取 */
  kind?: 'kb' | 'web'
  /**
   * 检索层产出的融合分（RRF：各路排名 1/(60+rank) 之和，典型 0.01–0.05）。
   * 语义：**同一轮检索内**越大越相关（已按它排序）；它既不是余弦相似度、也不是概率，
   * 跨轮次/跨知识库集合/跨阈值策略都不可比。旧消息没有该字段（不显示、不按 0 分处理）。
   */
  score?: number
}

/**
 * 一轮回答的知识库检索事实（P0-2b）。
 * 「检索过但 0 条达标」「整次失败」「压根没启用」以前在界面上完全一样（都靠 sources.length 推断），
 * 现在由检索层如实写下，渲染层只念这份事实。
 * 存储：塞在 messages.sources 那一列的 envelope 里（`{ items, retrieval }`），不新增列、不迁移；
 * 旧行的纯数组形状照旧可读。
 */
export interface MessageRetrieval {
  /** 本轮是否真的发起过知识库检索（false＝未启用知识库/未触发） */
  searched: boolean
  /** 达标条数（searched=true 且未失败时才有意义） */
  hits: number
  /** 整次检索异常/超时：一条都没注入 */
  failed?: boolean
  /** 本次参与检索的知识库数量 */
  kbCount?: number
}

// ---------- KB 问答模式（知识库详情页内选库即聊，轻量流式） ----------

/**
 * 追问历史最多携带条数（§318：这个数只有出处一份）。
 * 曾经有两个数各管一摊——IPC 入参 schema 卡 50、主进程拼消息时裁到 10，
 * 于是「第 26 轮起发不出去」被 schema 挡死，而主进程本来就会丢掉 11 条以后的：
 * 上限写两处，迟早和实现不一致（与 §154/§266 立的『别把同一件事抄第二遍』同一条）
 * 渲染层发之前按它裁，主进程再兜一次。
 */
export const KB_ASK_MAX_HISTORY = 10
export interface KbAskMessage {
  role: 'user' | 'assistant'
  content: string
  /** 仅 assistant 消息携带：本轮引用来源 */
  sources?: MessageSource[]
}
export interface KbAskChunkEvent {
  requestId: string
  delta: string
}
export interface KbAskDoneEvent {
  requestId: string
  fullContent: string
  sources: MessageSource[]
}
export interface KbAskErrorEvent {
  requestId: string
  error: string
}

/** KB 问答会话落库记录（messages 以 JSON 单列存储，一行一个会话） */
export interface KbAskSessionRecord {
  id: string
  kbId: string
  /** 首问截断生成的会话标题 */
  title: string
  messages: KbAskMessage[]
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
}
/** KB 问答会话列表项（瘦身元数据，不含消息正文） */
export interface KbAskSessionMeta {
  id: string
  kbId: string
  title: string
  messageCount: number
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
}

/** KB 问答历史自动清理策略（双 0 = 关闭，不静默删数据） */
export interface KbAskRetention {
  /** 每库最多保留最近 N 条（0 = 不限） */
  keepCount: number
  /** 保留最近 N 天（0 = 不限） */
  keepDays: number
}

/** 跨库漫游列表项：会话元数据 + 所属库名（库缺失时为空串，UI 兜底显示） */
export interface KbAskRoamItem extends KbAskSessionMeta {
  kbName: string
}

/** 会话导出/导入文件载荷（明文 JSON 与加密 .moxia 内部同构） */
export interface ConversationExportPayload {
  version: number
  exportedAt: number
  conversation: ConversationRecord
  messages: MessageRecord[]
  assistant?: AssistantRecord | null
}

/** 外部记录导入入参：渲染端读好的文件文本（≤10 个，单个 ≤30MB 由 IPC schema 限） */
export interface ConversationExternalImportPayload {
  files: Array<{ name: string; text: string }>
}

/** 外部记录导入结果：单会话失败回滚不中断，整体统计回传 */
export interface ConversationExternalImportResult {
  ok: boolean
  conversationCount: number
  messageCount: number
  skippedConversationCount: number
  /**
   * 消息级丢弃的分类计数（V4-Iter-370）。上面那几个数只算"会话"和"已收下的消息"，
   * 文件里被跳过的行过去哪儿都不说 ⇒ 「导入 800 条」可以比真实消息少几十条而屏上一句没有。
   */
  droppedMessages: ExternalDroppedMessages
  /** 回码＋槽位（句子由渲染层按码取四语，出处在 where） */
  warnings: ExternalWarning[]
  error?: string
}

/** 消息全局搜索结果（FTS 命中与 LIKE 兜底的统一形状） */
export interface MessageSearchResult {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: MessageRole
  content: string
  snippet: string
  createdAt: number
}

// ---------- 知识库 ----------
export type KbDocStatus = 'pending' | 'parsing' | 'indexing' | 'ready' | 'error'
export type KbSourceType = 'pdf' | 'docx' | 'xlsx' | 'html' | 'url' | 'txt' | 'md' | 'image'

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
  /** 相似度阈值（0–1，0=不过滤）：与检索用查询向量的余弦相似度低于它就不注入。
   *  绝对值随 embedding 模型而变，不能横向比较——用「检索测试」面板试出来再定。 */
  minScore: number
  /** RAG 重排序 LLM provider（空则跳过 rerank，仅用 RRF） */
  rerankProviderId: string | null
  rerankModel: string | null
  /** HyDE 查询重写 LLM provider（空则用原 query 做向量检索） */
  hydeProviderId: string | null
  hydeModel: string | null
  /** Multi-Query 多查询扩展 LLM provider（空则只检索原 query） */
  multiQueryProviderId: string | null
  multiQueryModel: string | null
  /** 图片 OCR 视觉模型 provider（空则图片文档不可入库；识别文字后走常规索引） */
  ocrProviderId: string | null
  ocrModel: string | null
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
  /** file 文档入库时的内容 sha256（增量同步检测用；旧数据/非 file 类型为 null） */
  contentHash: string | null
  /** 文档级检索开关：false 临时排除出检索范围（不删除、不重索引） */
  enabled: boolean
  createdAt: number
  /** §394：最后一次状态变更时间；旧数据（迁移前）或新建时可能缺，健康检查回退到 createdAt */
  updatedAt?: number | null
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
  /** 所属知识库 id（来源跳转原文用） */
  kbId: string
  /** 分块在文档内的序号（来源跳转原文定位用） */
  seq: number
  docTitle: string
  content: string
  score: number
  /** 命中来源路：向量检索 / BM25 全文检索（诊断模式才填充） */
  sources?: Array<'vector' | 'bm25'>
  /**
   * 与本次检索所用查询向量的余弦相似度（-1~1）。
   * 只在「检索测试面板（诊断）」或「该库设了相似度阈值」时才算——主链路无阈值时不算，
   * 免得每次检索多读一遍候选向量。没向量或维度不符的候选不带这个字段。
   */
  similarity?: number
}

export interface RetrievalResult {
  query: string
  chunks: RetrievedChunk[]
}

/** 一次检索里没跑成的某一路（A3 可观测性：降级不再全静默） */
export interface RetrievalDegradation {
  /** 哪一路：向量 / BM25 全文 / HyDE / Multi-Query / 重排 / MMR / 整次检索（调用点兜底） */
  stage: 'vector' | 'bm25' | 'hyde' | 'multiQuery' | 'rerank' | 'mmr' | 'threshold' | 'retrieve'
  /** 发生在哪个库（整次检索级缺省） */
  kbId?: string
  /** 人话原因，直接取自错误信息或固定文案 */
  reason: string
}

/** 检索诊断信息（检索测试面板用，聊天主链路不产出） */
export interface RetrievalDiagnostics {
  hydeUsed: boolean
  queryVariants: string[]
  vectorHits: number
  bm25Hits: number
  rerankUsed: boolean
  candidateCount: number
  /** 相似度阈值（每库 min_score）滤掉了多少条；0 = 没滤过（未配置或无查询向量可比） */
  filteredByThreshold: number
  /** 本次检索没跑成的路（空数组=一切正常）；主链路不产出，但同样会记一条 WARN 日志 */
  degradations: RetrievalDegradation[]
  /** 各阶段耗时毫秒：hyde/multiQuery/search/rerank/mmr/total */
  timings?: Record<string, number>
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
  /**
   * source='mcp' 且 name 被改名时（与内置工具或另一 Server 重名、非法函数字符名）
   * 传给 MCP Server 的原始工具名；未改名时缺省，调用方用 name。
   */
  remoteName?: string
  /**
   * source='mcp'：Server 在 tools/list 里自己声明的注解（原样收回来，不做类型承诺）。
   * 只用来两件事——**不让名字词表把一个自称 destructive 的工具升成 auto**、以及界面显示
   * 「这个 server 说了什么」。规范写明注解不可作为安全依据，所以它**永远不会**单独将工具升到 auto。
   */
  mcpAnnotations?: McpToolAnnotations
  /**
   * 强制逐次确认：命中的工具即使被用户勾过「本次会话总是允许」也必须重新询问，
   * 且审批弹窗不提供「总是允许」。当前只由 MCP 破坏性/开放世界注解或危险关键词置位。
   */
  forceConfirm?: boolean
  /**
   * 成本提示档（只声明、只展示）：'high' 表示该工具可能调用外部付费服务，
   * 实际开销取决于用户的服务商／知识库配置。仅用于策略屏与能力中心的提示，
   * 不参与权限判定、不改变审批与执行行为。
   */
  costTier?: 'high'
  timeoutMs?: number // 单工具执行超时（毫秒），未配置时使用默认 30s
}

/** MCP 工具注解（协议里的 annotations，五个布尔 + 一个展示名） */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** 工具策略屏的一档（只读）：取值全部来自 toolRegistry 的同一处判定，渲染端不另写规则 */
export type ToolPolicyState = 'available' | 'disabled' | 'needs-explicit' | 'denied' | 'not-granted'

export interface ToolPolicyEntry {
  id: string
  name: string
  source: 'builtin' | 'mcp'
  /**
   * 仅 source='mcp' 时填充：这条工具属于哪个 Server（取自 ToolSchema.mcpServerId）。
   * 加它是为了让能力中心按 Server 汇总「已授权 N 个助手」时不必去猜 `mcp:<serverId>:<name>` 前缀。
   * 纯增量字段：既有快照消费方（ToolPolicyDialog 等）只读 id/name/source/state/granted，不受影响。
   */
  mcpServerId?: string
  permission: 'auto' | 'confirm' | 'deny'
  state: ToolPolicyState
  /** 是否有按参数动态判定（当前只有 shell_exec） */
  dynamic: boolean
  /** 静态基线的原因码（如 WRITES_WORKSPACE_FILE）；动态工具见 shell 那一段 */
  reasons: ToolPolicyReasonCode[]
  /** 仅「当前助手」视角：这条工具是否在该助手的授权面内（与 isToolAllowedBy 同一判定） */
  granted?: boolean
  /** 成本提示档，原样取自 ToolSchema.costTier；仅供渲染端展示，不参与任何判定 */
  costTier?: 'high'
}

export interface ShellPolicySnapshot {
  enabled: boolean
  policy: ShellPolicy
  /** 需要批准的原因码，与 classifyCommand 的规则表同源 */
  confirmReasons: string[]
  /** 永不执行的原因码，与 DENY_RULES 同源 */
  denyReasons: string[]
}

/** 传给 policySnapshot 的助手上下文（由 IPC 层用 resolveAgentToolPermissions 解析好） */
export interface ToolPolicyAssistantContext {
  id: string
  name: string
  isBuiltin: boolean
  permissions: string[]
  emptyPermissions: boolean
}

/** 「当前助手」视角：授权列表由 resolveAgentToolPermissions 解析后再交给 isToolAllowedBy */
export interface ToolPolicyAssistantView extends ToolPolicyAssistantContext {
  /** 生效面里是否有 load_skill；没有则按需技能会退化为全文注入 */
  loadSkillAvailable: boolean
  /** 该助手实际生效的工具面（判定值仍来自 isToolAllowedBy） */
  tools: ToolPolicyEntry[]
}

export interface ToolPolicySnapshot {
  /** 注册表全量视角（不随助手变化） */
  tools: ToolPolicyEntry[]
  shell: ShellPolicySnapshot
  /** 当前助手视角；未传 assistantId 或找不到该助手时为 undefined */
  assistant?: ToolPolicyAssistantView
  /** 未启动的 MCP Server 数：它们的工具不在任何一列，屏上单独说明 */
  mcpStoppedServers: number
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
  /** http 传输的自定义请求头（如 Authorization: Bearer xxx）；stdio 恒为 {} */
  headers: Record<string, string>
  createdAt: number
  /**
   * SEC-5：是否信任该 Server 的「只读命名」工具免确认。默认 false ⇒ 该 Server 的全部工具
   * 每次调用都要人工确认（工具名与描述由 Server 自报，名字骗人即可绕过确认）。
   */
  trustReadOnly: boolean
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
  /** 已进入工具面的工具（超过 MAX_MCP_TOOLS 的部分不在其中） */
  tools: ToolSchema[]
  /** 这次 tools/list 声明的总数（含被截断的）；未运行时为 0 */
  toolsTotal: number
  /** 因超过 MAX_MCP_TOOLS 而未进入请求的条数（= toolsTotal - tools.length） */
  toolsHeldBack: number
  lastError: string | null
  pid?: number
}

export interface McpServerStatusEvent {
  serverId: string
  status: McpServerStatus
  tools?: ToolSchema[]
  toolsTotal?: number
  toolsHeldBack?: number
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
export type AgentStepType =
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'final'
  | 'error'
  | 'todo'
  | 'replan'
  | 'user'
  /** 运行中插队（V4-Iter-238）：引擎在步与步之间收下并落库，渲染端据此把排队项换成用户卡 */
  | 'interject'

/** 任务清单条目（todo_write 工具维护，渲染端步骤化 checklist 展示） */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AgentStepEvent {
  requestId: string
  conversationId: string
  stepIndex: number
  type: AgentStepType
  text?: string // thought/final 的文本
  toolCall?: ToolCall // tool_call 步骤
  toolResult?: ToolResult // tool_result 步骤
  todos?: TodoItem[] // todo 步骤：当前完整任务清单
  error?: string
  messageId?: string // 持久化到 DB 的消息 ID（assistant/tool 消息）
  done?: boolean // 是否为最后一步
  /**
   * 插队事件（type='interject'）专用：渲染层排队项的本地 id。
   * 它不是 DB 字段，只用来把「已落库」这件事对回那条排队中的消息
   * （会话切走了也算对回——归属看 requestId，与卡片显示的两条判据不同）。
   */
  clientRef?: string
}

/**
 * 一次 Agent 运行的汇总统计（DONE 事件携带，渲染层展示本次运行成本）。
 *
 * **口径（V4-Iter-163，用户 2026-10-17 选定）**：`totalTokens` 按**整棵编排树**算（父 + 直接子），
 * `totalDurationMs` 与 `stepCount` 只算**主干**——父那一步 `delegate_task` 的耗时已经包住了整段子运行，
 * 再加一遍会把墙钟虚报；而子的 token 不加上就是少报成本（162 实测：界面 6,736 / 真烧 9,833）。
 * `childRuns` 只在 >0 时给（界面上"含几次子代理"要有依据可说，而子会话的步骤不在这份明细里）。
 */
export interface AgentRunStats {
  totalDurationMs: number
  totalTokens: number
  stepCount: number
  childRuns?: number
}

/** 会话级累计统计（跨该会话全部运行聚合，刷新后仍可恢复）；口径同上：次数与耗时算主干，token 含子 run */
export interface AgentSessionStats {
  runCount: number          // 运行次数 = 主干的 DISTINCT request_id（子 run 不另计一次"运行"）
  totalDurationMs: number   // 主干全部运行耗时之和
  totalTokens: number       // 全部运行 token 之和（含子 run）
  /** 主干全部运行的步数之和（与 `AgentRunStats.stepCount` 同一口径：只算主干） */
  totalSteps?: number
  childRuns?: number
}

/**
 * P2（V4-Iter-459）：会话的一轮运行索引（只读）。
 *
 * 与既有两个接口的区别：`AGENT_GET_LATEST_RUN_STATS` 只回答「最近一次」，`AGENT_GET_RUN_STATS`
 * 要调用方先知道 requestId；这里一次性列出该会话全部 run 并按 `request_id` 聚合，
 * 供对话页把摘要挂到**对应轮次**上（`messages` 没有 requestId 列，映射靠 `agent_traces.message_id`，
 * 缺失时渲染层用 `created_at` 区间兜底）。
 *
 * 口径与 `statsByRequest` 同一条：步数/耗时只算主干，token 含子 run（`childRuns` 仅在 >0 时给）。
 * `changeCount` 也仅在至少一步真的记下变更清单时给；`undefined` ≠ 没有变更。
 */
export interface AgentRunIndexEntry {
  requestId: string
  conversationId: string
  /** 这一轮首条 trace 的写入时间（映射兜底用） */
  startedAt: number
  /** 这一轮最后一条 trace 的写入时间 */
  endedAt: number
  stepCount: number
  totalDurationMs: number
  totalTokens: number
  /** 主干里 status='error' 的步数 */
  errorSteps: number
  /** trace 行上记的 `message_id`（换行/逗号分隔的多值已拆开去重），渲染层据此优先映射轮次 */
  messageIds: string[]
  /** 执行后变更清单里的路径条数（只有记过才给） */
  changeCount?: number
  /** 本轮包含几次子 run（仅 >0 时给，口径同 AgentRunStats） */
  childRuns?: number
  /**
   * 本轮子 run 落在哪些子会话（仅 >0 时给）。
   * 数据源是子 run 的 trace 行 `conversation_id`：每条子 run 在独立子会话里写步骤，
   * 轮次检查器据此提供「进对应子会话」的入口（P2 / V4-Iter-459）。
   */
  childConversationIds?: string[]
}

/** Agent 轨迹回放可用性（P0-5 冷 blob 第一批）：三档互不兜底，判据见 `main/agent/trace-replay.ts` */
export type TraceReplayState =
  /** 卸载文件与对应 `messages` 行都在：可以按 `messageId` 读回全文 */
  | 'replayable'
  /** 有引用记录，但文件或 `messages` 行已不在（文件被淘汰、消息被删/被清扫） */
  | 'expired'
  /** 从未留全文：旧行没有引用列，或内容从未超过截断上限 */
  | 'never_stored'

/** 执行后变更清单里的单个路径（只记录事实，不承诺可还原） */
export interface WorkspaceChangeEntry {
  /** 相对受保护目录的路径（不落绝对路径） */
  path: string
  kind: 'added' | 'modified' | 'deleted'
  /** 变更后的字节数；删除项用变更前的字节数 */
  size: number
  /**
   * 内容可比对状态：
   * - `hashed`：变更项取过当前文件哈希（只是指纹，**没有变更前内容可对比**）；
   * - `mtime-only`：大小没变、只有 mtime 变了；前扫没有存内容，无法判断内容是否真的变了；
   * - `binary`／`too-large`：未取内容，**不可比对**；
   * - `unreadable`：读取失败；
   * - `not-compared`：删除项，后扫已看不到文件，只能报大小。
   */
  content: 'hashed' | 'mtime-only' | 'binary' | 'too-large' | 'unreadable' | 'not-compared'
  /** 变更后指纹（仅 content='hashed' 时给；它不能用来还原） */
  afterSha?: string
}

/** 变更清单降级原因：任一闸门超限都整次降级，不产出半份清单 */
export type WorkspaceChangeDegradedReason =
  | 'too-many-files'
  | 'too-many-bytes'
  | 'timeout'
  | 'too-many-changes'
  | 'before-scan-failed'
  | 'after-scan-failed'
  /**
   * 本步只执行了**自动放行**的 shell／MCP 调用：它们不做前后扫描（每一步固定两扫的代价
   * 会落到所有步骤上），因此这一档写"未记录"，而不是留 NULL 冒充"没有变更"。
   */
  | 'auto-allowed-not-recorded'

/**
 * 一次 shell／MCP 步骤执行后的工作目录变更清单（v55，只读事实）。
 *
 * **口径**：只回答"改了哪些路径、大小多少"，不回答"内容改成了什么"，
 * 也不提供回滚——回滚只存在于 `fs_write` 的单文件快照（2 MiB／100 份／有失败态）。
 * 超出任一闸门时 `status='degraded'` 且 `entries` 为空，表示**本次未记录变更**，
 * 绝不能把空清单演成"没有变更"。
 */
export interface WorkspaceChangeSet {
  status: 'ok' | 'degraded'
  entries: WorkspaceChangeEntry[]
  counts: { added: number; modified: number; deleted: number }
  /** 前扫 + 后扫的实际耗时（毫秒） */
  scanMs: number
  degradedReason?: WorkspaceChangeDegradedReason
}

/** Agent 单步执行轨迹（agent_traces 表一行，渲染层分步明细用） */
export interface AgentTraceRecord {
  id: string
  requestId: string
  conversationId: string
  /**
   * v48：控制器那一次 request。
   * undefined = 这一行属于用户自己发起的运行；非 undefined 时它是某次委派的子运行的一步，
   * 成本/耗时按整棵编排树聚合就靠这一列（角色在 conversations.role_key 上，不在这里重复）。
   */
  parentRequestId?: string | null
  stepIndex: number
  stepType: 'llm' | 'tools' | 'final' | 'degrade' | 'replan'
  toolName?: string
  durationMs?: number
  tokenUsage?: number
  /**
   * 本步输入 token（= 每步重发的上下文：系统提示词 + 工具 schema + 历史）。
   * provider 未上报 usage、或本次改动前的旧 trace 行为 undefined。
   */
  promptTokens?: number
  /** 本步输出 token（思考模型的 reasoning 也计在这里） */
  completionTokens?: number
  status: 'success' | 'error'
  error?: string
  /**
   * v50（V4-Iter-232）：这一步的**入参原文**（多个工具调用时按调用顺序用换行分隔，每段带工具名）。
   * 只在 `stepType='tools'` 那一类步骤上有值；写入端按 `TRACE_TEXT_MAX_CHARS` 截断并留一句"完整 N 字符"，
   * 所以这一列是**可诊断的线索**，不是"存档的副本"——全文按 `messageId` 去 `messages.content` 读，
   * 卸载文件只是缓存（见 v54 的 `messageId`／`coldRef`）。
   */
  toolArgs?: string
  /** v50：这一步的**返回值原文**（同上，截断口径一致；错误结果也照存，那正是最该看的一种） */
  toolResult?: string
  /**
   * v55：这一步执行后工作目录的**变更清单**（JSON 字符串，形状见 `WorkspaceChangeSet`）。
   * 只在含 shell／MCP 调用的 tools 步骤上尽力记录；NULL＝没记录（旧行、无目标工具、前扫失败等），
   * 与"没有变更"不是一回事——渲染层必须分开说。
   */
  changeSet?: string
  /**
   * v54（P0-5 冷 blob 第一批）：这一步被截断的返回值反查 `messages` 的钥匙。
   * 多个工具调用时按调用顺序换行分隔（与 `toolArgs`／`toolResult` 同序同分法），
   * 只收录**长度超过 `TRACE_TEXT_MAX_CHARS`** 的那些调用；NULL＝从未留全文。
   */
  messageId?: string
  /**
   * v54：卸载文件的相对引用（`@outputs/<file>.txt`），与 `messageId` 同序对应，空段表示该调用没落文件。
   * **这是缓存不是权威存储**：读回放一律走 `messages.content`，文件没了不代表原文没了。
   */
  coldRef?: string
  /** v54：被截断返回值的原始长度，口径是 **JS String.length（字符数）**，与"完整 N 字符"一致 */
  resultChars?: number
  /**
   * 回放可用性（主进程按"文件 + `messages` 行是否都在"判定后附上，见 `agent/trace-replay.ts`）。
   * 渲染层拿到的记录可能不带这一颗：不带＝调用方没走判定，不代表可回放。
   */
  replay?: TraceReplayState
  /**
   * v50：跑这一步的那台模型。
   * 为什么不能由会话上那一个 `model` 推出来：跨模型角色（§145／§150）之后子运行可以换模型，
   * 而整棵编排树的成本／耗时聚合（§163）本来就跨多个 request ⇒ "哪一步用了哪台"只能逐步记。
   */
  model?: string
  createdAt: number
}

export interface AgentDoneEvent {
  requestId: string
  conversationId: string
  finalMessageId: string
  fullContent: string
  stepCount: number
  /**
   * §396：**只在主进程那一发 trace 统计真读到时携带**。读不出来时不带这一颗——
   * 原先失败回一份 `{0,0,0}`，屏上「0 步 · 耗时 0ms · 0 tokens」与"这轮确实一步没跑成"同一个形状，
   * 而旁边就躺着我们知道真值的 `stepCount`。缺这一颗时渲染层走既有的重读那一发＋那颗「读不到」。
   */
  traceStats?: AgentRunStats
  /** 知识库引用来源（RAG 检索命中的 chunk），仅最终回答无 tool_calls 时携带 */
  sources?: MessageSource[]
  /** 本轮知识库检索事实（与 sources 同源；为让 0 命中/失败即时可见，不只等下次重读） */
  retrieval?: MessageRetrieval
  /** 本次运行是否实际调用了工具（用于零调用提示） */
  usedTools?: boolean
  /**
   * 本次因「'*' 只授权内置」而被挡在工具面外的 MCP 工具数（V4-Iter-110 的可观测性）。
   * 只在 >0 时携带；渲染层附在零调用提示里，告诉用户"不是模型懒，是工具没给"。
   */
  mcpHeldBack?: number
  /**
   * 本轮因「按需装载工具」而未进入请求的内置工具数（工具面治理，候选 A）。
   * 只在 >0 时携带。与 `mcpHeldBack` **不是同一个数字**：那个数的是"因 `'*'` 只给内置
   * 而被授权规则挡下的 MCP 工具"，这个数的是"分组没命中而没发 schema 的内置工具"。
   */
  toolGroupsHeldBack?: number
  /**
   * 这一轮的固定开销（system＋工具清单＋技能＋记忆）已经超过这台模型**声明过的**窗口，
   * 历史只带了最近一问（V4-Iter-237 把 §234 那句只进日志的实话搬上屏）。
   * 只在 true 时携带；没声明过窗口的模型永远不带——那把尺子量不了它，猜出来的句子不能说。
   */
  historyTight?: boolean
}

/** Agent 流式文本增量（逐 token 推送） */
export interface AgentChunkEvent {
  requestId: string
  conversationId: string
  stepIndex: number
  messageId: string
  delta: string
  /** 这一段是思考增量（引擎在 onReasoningDelta 里带 true，正文段不带这个键） */
  reasoning?: boolean
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

/** 联网搜索服务商（tavily/bocha 需 Key；searxng 免 Key，需用户自建或可信实例地址） */
export const WEB_SEARCH_PROVIDERS = ['tavily', 'bocha', 'searxng'] as const
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number]

/** 搜索深度（模型可传 / 实际执行）：quick＝单路标题+摘要；deep＝并行 3 路 + 前 3 条补读正文 */
export const WEB_SEARCH_DEPTHS = ['quick', 'deep'] as const
export type WebSearchDepth = (typeof WEB_SEARCH_DEPTHS)[number]

/** 配置档位：auto＝不干预（模型自己选，缺省 quick）；quick/deep＝强制覆盖模型的选择 */
export const WEB_SEARCH_DEPTH_SETTINGS = ['auto', 'quick', 'deep'] as const
export type WebSearchDepthSetting = (typeof WEB_SEARCH_DEPTH_SETTINGS)[number]

export interface WebSearchConfig {
  enabled: boolean
  provider: WebSearchProvider
  /** 渲染端永远拿到空串（Key 不回显明文），是否已配置看 hasKey */
  apiKey: string
  hasKey: boolean
  /** SearXNG 实例基地址（空串=未配置；不内置任何公共实例） */
  searxngBaseUrl: string
  /** 用户显式确认允许该 SearXNG 地址访问本机/内网（仅对此精确 origin 生效） */
  searxngAllowPrivate: boolean
  /** 搜索深度档位：auto＝跟随模型（默认）、quick/deep＝强制覆盖 */
  depth: WebSearchDepthSetting
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

// ---------- 成品文件（v67 artifacts 表；文件本体存 data/generated/） ----------
/** 目前做 PPTX / DOCX / XLSX / Markdown；xlsx 由 SheetJS CE 生成（不做单元格样式） */
export type ArtifactKind = 'pptx' | 'docx' | 'xlsx' | 'md'

export interface ArtifactMeta {
  id: string
  kind: ArtifactKind
  /** 模型给的标题（已清洗，展示用） */
  title: string
  /** 磁盘文件名（含扩展名，落在 DATA_DIR/generated/ 下） */
  fileName: string
  /** 相对 DATA_DIR 的路径（`generated/xxx.pptx`），复用文件模块的另存为/打开/定位 */
  relPath: string
  /** 字节数 */
  size: number
  createdAt: number
  /** 生成它的会话；非 Agent 路径为 null */
  conversationId: string | null
  /** 生成它的运行标识（幂等键之一）；非 Agent 路径为 null */
  requestId: string | null
  stepIndex: number | null
}

export interface ArtifactPptxOutlineSlide {
  title: string
  lines: string[]
}

/** xlsx 预览：SheetJS 读回后的纯文本行数组（首行为表头） */
export interface ArtifactXlsxSheetPreview {
  name: string
  rows: string[][]
  /** 原始行/列数，用于界面提示「仅展示前 N 行 / M 列」 */
  totalRows: number
  totalCols: number
  truncated: boolean
}

/**
 * 产物预览。注意：pptx 只给**文字大纲**——离线环境没有可靠的 .pptx 渲染器，
 * 这里不承诺还原版式（界面文案也不许说"预览成品"）。
 * docx 给 mammoth 转出的**只读 HTML**，渲染端必须放进不带 allow-scripts 的 sandbox iframe。
 * xlsx 给按行列上限截断后的纯文本表格，只用于看内容，不还原列宽/合并/样式。
 */
export interface ArtifactPreview {
  id: string
  kind: ArtifactKind
  /** 磁盘文件已不在（被用户/杀软/清理工具删掉） */
  missing: boolean
  /** pptx：按页提取的文字；顺序与文件中的页序一致 */
  slides?: ArtifactPptxOutlineSlide[]
  /** md：正文 */
  markdown?: string
  /** docx：mammoth 转出的 HTML（空串＝转换失败）；只可放进无脚本沙箱渲染 */
  html?: string
  /** xlsx：工作表内容（最多 10 张、每张最多 200 行 × 30 列） */
  sheets?: ArtifactXlsxSheetPreview[]
  /** 预览读取失败时的可见原因（xlsx 用；界面必须显式展示，不许静默空表） */
  error?: string
  /** 内容过长被截断 */
  truncated?: boolean
}

/**
 * 产物全文读取结果（md 导出 PDF 专用）。
 * 与 `file:read`（256KB 截断）、`artifact:preview`（20 万字符截断）刻意分开：
 * 导出 PDF 时**超限必须拒绝**，绝不能拿截断后的正文去打印——那等于静默丢半篇。
 */
export interface ArtifactTextResult {
  ok: boolean
  error?: string
  /** 全文（utf8）；仅在 ok 时存在 */
  text?: string
}

/** 产物导出 PDF 的结果：取消不是错误（canceled=true），失败才给 error */
export interface ArtifactPdfExportResult {
  ok: boolean
  error?: string
  canceled?: boolean
  /** 用户选择的目标路径；仅成功时存在 */
  path?: string
}

/** 多文件项目（v70）：目录形态产物，不是单个文件 */
export interface ProjectFileEntry {
  /** 项目内相对路径（POSIX 分隔符） */
  path: string
  sha256: string
  size: number
}

export interface ProjectMeta {
  id: string
  name: string
  /** DATA_DIR/generated/projects/ 下的目录名（同名时带 -2/-3） */
  dirName: string
  fileCount: number
  totalBytes: number
  createdAt: number
  /** 相对 DATA_DIR 的定位路径，供 file:open-location 使用 */
  relPath: string
}

/** 项目预览：只承诺清单与入口文本，不承诺整站（css/js/图片无本地静态服务） */
export interface ProjectPreview {
  id: string
  name: string
  dirName: string
  relPath: string
  fileCount: number
  totalBytes: number
  files: Array<{ path: string; size: number }>
  /** 根目录 index.html（≤300KB；超出截断并置 truncated） */
  indexHtml?: string
  /** 根目录 README.md 正文（≤200KB） */
  readme?: string
  truncated?: boolean
}

/** 工具审批弹窗语义化预览字段（构造见 src/shared/tool-preview.ts） */
export interface ApprovalPreviewField {
  /** i18n key 后缀：渲染端映射 agent.approval.field.<key>，缺失回退显示原始值 */
  key: string
  value: string
  /** true=等宽 pre 块展示（代码/命令/长文本） */
  mono?: boolean
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
  /** 强制逐次确认：会话白名单不生效，弹窗不提供「总是允许」 */
  forceConfirm?: boolean
  /** 语义化预览字段（MCP 等非 shell 工具）；存在时渲染端替代 command 块展示 */
  fields?: ApprovalPreviewField[]
  /** shell 命令危险片段字符区间（对 command 下标），渲染端标红 */
  highlights?: Array<{ start: number; end: number }>
}

export interface ToolApprovalResponsePayload {
  approvalId: string
  approved: boolean
  /** 勾选「本次会话总是允许」：后续同会话同工具名直接放行（不落库） */
  alwaysAllow?: boolean
}

/** 审批落库的判定结果（只用于审计，不参与执行控制） */
export type ApprovalDecision = 'auto_allow' | 'user_approve' | 'user_deny' | 'timeout_deny' | 'policy_deny'
/** 审批范围：单次 / 本次会话白名单（当前没有永久白名单） */
export type ApprovalScope = 'once' | 'session'

/** 审计写入所需的调用上下文（事件本身没有这些字段，由引擎补齐） */
export interface ApprovalAuditContext {
  assistantId?: string | null
  stepIndex?: number
  toolCallId?: string
  toolId?: string
  argsJson?: string | null
  requestedAt?: number
  /**
   * settle 时回写审计账本。由引擎注入 `recordApprovalDecision`，
   * tool-approval 因此不直接 import DB/repo —— 审批单元测试不该被 electron/portable 拉下水。
   */
  record?: (input: ApprovalAuditWriteInput) => void
}

/** createApproval 决定落账时交给引擎回调的载荷（与 approval-audit 的 RecordApprovalInput 同形） */
export interface ApprovalAuditWriteInput {
  requestId: string
  conversationId: string
  toolName: string
  decision: ApprovalDecision
  reasonCode: string
  scope: ApprovalScope
  argsDigest: string
  argsJson: string | null | undefined
  context: Omit<ApprovalAuditContext, 'record'>
  emit: (channel: string, payload: unknown) => void
}

/** approval_events 写入行（repo 内部使用） */
export interface ApprovalEventInput {
  requestId: string
  conversationId: string
  assistantId: string | null
  stepIndex: number | null
  toolCallId: string | null
  toolId: string
  toolName: string
  decision: ApprovalDecision
  reasonCode: string | null
  scope: ApprovalScope
  argsDigest: string | null
  argsRedacted: string | null
  actor: string
  requestedAt: number
  decidedAt: number
}

/**
 * 审批明细屏的查询入参（P0-2c-3）。
 * `limit` 在 IPC 层用 zod 封顶 100——这一屏**永远分页取**，不接受"一次拉全表"；
 * `from`/`to` 是 `created_at` 的毫秒闭区间（渲染端按本地日界换算后传入）。
 */
export interface ApprovalAuditQuery {
  offset: number
  limit: number
  conversationId?: string
  decision?: ApprovalDecision
  from?: number
  to?: number
}

/**
 * 审批明细屏的一行（只含可展示字段）。
 * 没有原始参数、没有工具结果：`argsRedacted` 是唯一参数来源，`argsDigest` 只做短哈希。
 */
export interface ApprovalAuditRow {
  id: string
  conversationId: string
  assistantId: string | null
  stepIndex: number | null
  toolId: string
  toolName: string
  decision: ApprovalDecision
  reasonCode: string | null
  scope: ApprovalScope
  /** 参数指纹（完整哈希）；界面只展示前 10 位，并注明不能还原内容 */
  argsDigest: string | null
  /** 写库前已脱敏的参数摘要；绝不回填/重拼原始参数 */
  argsRedacted: string | null
  actor: string
  requestedAt: number
  decidedAt: number
  /** 记录落库时间（= decidedAt）：列表排序与时间筛选都按这一列 */
  createdAt: number
}

/** 审批明细屏的一页（hasMore=还有下一页；不做总数统计，避免每次翻页多扫一遍全表） */
export interface ApprovalAuditPage {
  rows: ApprovalAuditRow[]
  hasMore: boolean
}

/** 审批明细导出格式：JSON 面向脚本，CSV 面向表格 */
export type ApprovalExportFormat = 'json' | 'csv'

/**
 * 审批明细导出入参：与屏幕筛选同口径（会话/决定/时间范围）。
 * 不含分页字段——导出由主进程按固定页大小收集，并受独立硬上限约束。
 */
export interface ApprovalExportQuery {
  format: ApprovalExportFormat
  conversationId?: string
  decision?: ApprovalDecision
  from?: number
  to?: number
}

/**
 * 审批明细导出结果：取消时没有文件路径；成功时带上实际行数与是否截断，
 * 界面必须如实提示"只导出了前 N 行"，不许静默截断。
 */
export type ApprovalExportResult =
  | { ok: true; canceled: true }
  | {
      ok: true
      canceled?: false
      path: string
      exportedRows: number
      truncated: boolean
      maxRows: number
    }

/** 审批审计写失败广播（主进程 → 渲染端；只提示一次，不阻断工具执行） */
export interface ApprovalAuditWarnEvent {
  at: number
  failures: number
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
  /** 无人值守场景（如 IM 通道）：需人工确认的工具不弹窗等待，直接返回错误 */
  unattended?: boolean
  /** 引用回复：本条用户消息引用的同会话另一条消息 id */
  replyToId?: string | null
  /** @ 引用的知识库 id 列表（从 attachments 中提取，仅发送时有效） */
  kbRefs?: string[]
}

/** 聊天附件（图片或文档） */
export interface ChatAttachment {
  type: 'image' | 'text' | 'kb'
  name: string
  mimeType: string
  size: number
  /** image: base64 data URL (data:image/png;base64,...) | text: 文件文本内容 | kb: 空串 */
  data: string
  /** kb 类型时必填：知识库 id */
  kbId?: string
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
  /** 知识库引用来源（RAG 检索命中的 chunk 元信息） */
  sources?: MessageSource[]
}

/** 智能标题后台生成完成事件（主进程广播，渲染端就地更新会话列表） */
export interface ConversationTitleEvent {
  conversationId: string
  title: string
}

export interface ChatErrorEvent {
  requestId: string
  targetIndex: number
  messageId: string
  error: string
}

/**
 * 会话运行态（B-2/D4）：主进程注册表的快照与增量事件共用这一形状。
 * `state='idle'` 是**移除**信号（运行结束/失败角标被清除），不是一种可见状态。
 * 只带身份与状态，不带任何消息内容（事件会广播到所有渲染窗口）。
 */
export type ChatRuntimeState =
  | 'running'
  | 'pending_approval'
  | 'failed'
  | 'interrupted'
  | 'idle'

/**
 * 运行阶段（v66 检查点）：回答"进程倒下时正处在哪一步"。
 * `preparing`=循环还没开始；`model`=正在调模型；`tools`=正在执行工具；`approval`=等人工审批；
 * `final`=正在生成最终回答（含超步降级那一发）。
 */
export type ChatRunStage = 'preparing' | 'model' | 'tools' | 'approval' | 'final'

/**
 * 重启对账后的续跑判定（v66）：`resumable`=中断点之前没有工具副作用，可从边界继续；
 * `restart`=已经进过工具步（或没有检查点），只能整轮重来。本版只判定、不自动续跑。
 */
export type ChatRunResume = 'resumable' | 'restart'

export interface ChatRuntimeStateEvent {
  /** 与未读事件共用一个通道，靠这个字段区分；运行态事件可以不带（历史形状不变） */
  kind?: 'runtime'
  conversationId: string
  /** 已清除/无归属时可为 null（当前实现总带 requestId） */
  requestId: string | null
  /** 只在新建运行时必填；后续状态迁移沿用首次登记的值 */
  mode?: 'chat' | 'agent'
  state: ChatRuntimeState
  startedAt?: number
  /** 这次状态变更的时间戳（界面不需要排序，只用于诊断） */
  at: number
  /** 待确认的审批数（state='pending_approval' 时 >0） */
  pendingApprovals?: number
  errorCode?: string
  /** v66：当前阶段；老记录/历史事件没有这一项（不编造） */
  stage?: ChatRunStage
  /** v66：已完成的步数边界（第几步之前的工作已经落库） */
  stepsDone?: number
  /** v66：只有 state='interrupted' 才有——中断后能不能接着跑 */
  resumeState?: ChatRunResume
}

/**
 * 会话未读（B-4）：与运行态共用 `CHAT_RUNTIME_STATE_EVENT` 通道与 `CHAT_GET_RUNTIME_STATES` 快照。
 * 不另开订阅，也不在渲染端二次推导——DB 的 `conversations.unread` 是唯一事实源，
 * 这里只是它的一份投影。
 */
export interface ChatUnreadEvent {
  kind: 'unread'
  conversationId: string
  /** true=有未读的助手消息；false=已读（渲染端镜像里移除） */
  unread: boolean
  at: number
}

/** 运行态 + 未读的联合事件形状（同一通道）。 */
export type ChatConversationStateEvent = ChatRuntimeStateEvent | ChatUnreadEvent

/** B-4：渲染端上报「这扇窗此刻是不是真的在读某个会话」。 */
export interface ChatReadStateReport {
  /** 当前显示的会话；null＝没有会话可见（切走/模块卸载） */
  conversationId: string | null
  /** document.hasFocus() */
  focused: boolean
  /** !document.hidden */
  visible: boolean
}

/** 上报的返回：清读之后该会话的未读真相（渲染端拿它对齐本地镜像，避免和快照赛跑）。
 *  null＝此刻问不到（锁屏时库是关的），渲染端跳过对齐、保持现状。 */
export interface ChatReadStateResult {
  ok: true
  unread: boolean | null
}

// ---------- 快捷浮窗 ----------
export type PopupMode = 'quick' | 'selection'

/** 选区助手动作（浮条按钮与浮窗动作芯片共用） */
export type SelectionAction = 'translate' | 'summary' | 'polish' | 'ask'

export interface PopupPayload {
  mode: PopupMode
  text?: string // selection 模式下取到的选中文本
  /** selection 模式下入口指定的动作；存在时浮窗就绪后自动执行（应用内划词浮条带此参） */
  action?: SelectionAction
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

// ---------- 卡密在线激活 ----------
/** 激活失败的稳定错误码：客户端据此走 i18n 差异化提示，不依赖服务端中文文案 */
export type ActivationErrorCode =
  | 'EMPTY_CODE' // 未输入卡密
  | 'FINGERPRINT_UNAVAILABLE' // 本机读不到硬盘序列号
  | 'NETWORK_UNREACHABLE' // 连不上激活服务器（断网/DNS/拒绝连接）
  | 'NETWORK_TIMEOUT' // 请求超时
  | 'RATE_LIMITED' // 触发限速
  | 'CODE_LOCKED' // 卡密失败次数过多被临时锁定
  | 'CODE_FORMAT_INVALID' // 卡密格式不对
  | 'CODE_NOT_FOUND' // 卡密不存在
  | 'ALREADY_BOUND_OTHER' // 卡密已绑定其他硬盘
  | 'FINGERPRINT_INVALID' // 服务端认为指纹格式非法（客户端过旧）
  | 'ISSUE_FAILED' // 服务端签发 license 失败
  | 'SERVER_ERROR' // 其他 5xx / 未知服务端错误
  | 'INVALID_LICENSE' // 下发的 license 未通过本地验签/指纹比对

export type ActivationResult =
  | { ok: true; status: LicenseStatus; /** license 原文，供 IPC 层落盘 */ license: string }
  | { ok: false; code: ActivationErrorCode; detail?: string }

// ---------- 自动更新 ----------
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'unavailable' | 'downloading' | 'downloaded' | 'error'

export interface UpdateInfo {
  /** package.json version */
  currentVersion: string
  /** 是否为 electron-builder 打包版本（dev 环境返回 false） */
  isPackaged: boolean
  /** 是否为 portable 格式（非 NSIS installer） */
  isPortable: boolean
  /** 自动更新开关是否开启（持久化于 app_config） */
  autoUpdateEnabled: boolean
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
  /** 「此刻有没有可用的密钥」——none 模式恒 true（没东西要解锁），db 模式锁定时 false */
  unlocked: boolean
  /** DB 是否已加密（sqlcipher 开启）＝只看模式，与解锁无关 */
  dbEncrypted: boolean
  /** 字段现在能不能加解密（none 模式是固定弱密钥，不是安全保障；§195） */
  fieldEncrypted: boolean
  /**
   * 当前主密码是否已验证通过。§359：这一发过去算的是 `hasKey()`，而它在 none 模式恒 true
   * ⇒ 一把主密码都没设过的库会被告知「主密码已验证通过」。现在只看 db 档且已解锁。
   * 合法组合（闸门 tests/encryption-status-shape-gate-359.test.ts 逼桩与代码一起对齐）：
   *  `mode:'none'` ⇒ 本字段必为 false（与 `dbEncrypted`/`kdfN:null`/`kdfAtCurrentTier:false` 同批）；
   *  `mode:'db'`   ⇒ 本字段＝`unlocked`。
   */
  masterPasswordVerified: boolean
  /** 库的主密码 scrypt 档位 N（SEC-32②）；无密码模式为 null */
  kdfN: number | null
  /** 该库是否已用现行档位（false ⇒ 改一次密码即自动升档） */
  kdfAtCurrentTier: boolean
}

/** 主密码解锁 / 恢复码重置的统一返回：成功仅 ok；失败带错误与主进程限流信息 */
export interface AuthResult {
  ok: boolean
  error?: string
  /** 本次失败是否触发了限流锁定（区别于普通密码错误） */
  locked?: boolean
  /** 距下次可尝试的剩余毫秒（锁定中或刚触发锁定时有意义） */
  retryAfterMs?: number
  /** 当前桶连续失败次数（供 UI 提示剩余尝试机会） */
  attempts?: number
}

/** ENCRYPTION_AUTH_STATUS 返回：解锁与恢复两个桶各自的限流状态 */
export interface AuthLockState {
  unlock: { retryAfterMs: number; attempts: number }
  recover: { retryAfterMs: number; attempts: number }
}

// ---------- Agent 定时提醒 ----------

export type ReminderStatus = 'pending' | 'fired' | 'cancelled' | 'missed'

/** 循环提醒规则（3 种 kind 覆盖日常场景，不做 cron 表达式） */
export type ReminderRepeatRule =
  | { kind: 'daily'; intervalDays: number }
  | { kind: 'weekly'; weekdays: number[] }
  | { kind: 'monthly'; dayOfMonth: number }

/** 一次性/循环提醒条目（reminder 工具创建，scheduler 到点触发或重排下一次） */
export interface ReminderRecord {
  id: string
  text: string
  /** 触发时间（epoch ms） */
  fireAt: number
  status: ReminderStatus
  conversationId: string | null
  createdAt: number
  /** 循环规则（无=一次性，到点 fired；有=到点重排为下次 pending） */
  repeatRule?: ReminderRepeatRule
}

/** REMINDER_FIRED 广播载荷；missed>0 表示重启后补发的过期提醒汇总 */
export interface ReminderFiredPayload {
  id?: string
  text?: string
  fireAt?: number
  /** 启动恢复时一次性补发的 missed 条数（>0 时无单条字段） */
  missed?: number
}

/** REMINDER_CREATE 入参（渲染端右键「提醒我」直建；时间由渲染端预设纯函数算好） */
export interface ReminderCreatePayload {
  text: string
  /** 触发时间（epoch ms，主进程二次校验 >now 且 ≤now+30d） */
  fireAt: number
  /** 来源会话（可空） */
  conversationId?: string | null
  /** 循环规则（可空，循环提醒首次触发时间仍受 30 天上限） */
  repeatRule?: ReminderRepeatRule
}

/** REMINDER_RESCHEDULE 入参（提醒中心历史 tab missed/cancelled 行「重新安排」） */
export interface ReminderReschedulePayload {
  id: string
  fireAt: number
  repeatRule?: ReminderRepeatRule
}

/** REMINDER_UPDATE 入参（提醒中心 pending 行编辑：改时间/文本/规则）；
 *  repeatRule: undefined=不改，null=清除变一次性，对象=改循环规则 */
export interface ReminderUpdatePayload {
  id: string
  text?: string
  fireAt?: number
  repeatRule?: ReminderRepeatRule | null
}

/** REMINDER_RESCHEDULE_NEXT 入参（历史 tab missed 循环行「重新安排」一键重算回 pending） */
export interface ReminderRescheduleNextPayload {
  id: string
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
  /** §377：VACUUM 抛了（SQLite busy／Windows 文件锁）——不许折进「回收 0 字节」当成功 */
  vacuumFailed: boolean
}

/** §377：手动 VACUUM 的结果——「跑没跑成」与「回收了几字节」是两件事 */
export interface VacuumOutcome {
  vacuumedBytes: number
  vacuumFailed: boolean
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
  /**
   * 码：'primary' | 'alternate' | 'embedding'（V4-Iter-156）。
   * 以前是中文「首选/备选/向量」，而 `OllamaPanel.tsx:132,133` 直接拿它做**过滤判断** ⇒
   * 逻辑挂在措辞上；改成码之后由类型系统守。界面按 `t('modelRec.tag.'+tag)` 取文案。
   */
  tag: ModelPickTagCode
  /** 码，界面按 `t('modelRec.reason.'+reason)` 取文案（156 起主进程不再返回整句） */
  reason: ModelReasonCode
  /** 是否已在本机 Ollama 中安装 */
  installed: boolean
}

export interface ModelRecommendation {
  /** 档位码（入门/主流/…，含 CPU 变体）：`modelRec.tier.*` */
  tier: ModelTierCode
  /** 硬件画像总结的码：`modelRec.summary.*`，插值走 summaryParams */
  summary: ModelSummaryCode
  /** 总结句里的参数（GPU 名只有主进程知道；量化阈值是分支常量，写在字典文案里） */
  summaryParams: Record<string, string | number>
  localPicks: ModelPick[]
  /** 在线模型使用建议的码：`modelRec.onlineHint.*`（低配档与非低配档各一句） */
  onlineHint: ModelOnlineHintCode
  /** §380：本机 Ollama 探测三态（与便携运行时面板同一口径）；只有 `down` 才支持"没在跑" */
  ollamaLiveness: OllamaLiveness
  installedModels: string[]
  /** 告警的码：`modelRec.warn.*` */
  warnings: ModelWarnCode[]
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

/** 提示词片段（用户自存常用提示词，content 可含 {{变量}} 占位） */
export interface PromptSnippetRecord {
  id: string
  title: string
  content: string
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

/**
 * §380：11434 探测结果的三态。分家的依据只有一个问题——**有没有人明确说"这里没人听"**：
 *  · `down`＝连接被拒（`ECONNREFUSED`／`EADDRNOTAVAIL`），确实没跑；
 *  · `up`＝那个 API 答上了话（2xx 且能解析出 JSON）；
 *  · `unknown`＝其余一切：探测超时、有人监听但回了非 2xx、回了 2xx 却解析不出。
 * 改前 `apiGetJson` 的 `catch { return null }` 与 `if (!res.ok) return null` 把这四类不同事实压成同一个 null，
 * 于是 `running:false` ⇒ 界面画「未运行」、把"3 秒内没答话"这种**我们不知道**说成**确定没有**。
 */
export type OllamaLiveness = 'up' | 'down' | 'unknown'

export interface OllamaRuntimeStatus {
  /** 当前平台是否提供便携发行包（仅 Windows x64 / Linux x64） */
  platformSupported: boolean
  /** 便携版二进制是否已下载解压 */
  installed: boolean
  /** 11434 探测结果（不区分便携/系统）；只有 `down` 才支持"没在跑"这句话 */
  liveness: OllamaLiveness
  /** 服务来源：便携 / 系统；只有 `liveness==='up'` 时才可能有值 */
  source: OllamaSource | null
  /** 服务版本；只有 `liveness==='up'` 时有值（其余两态都是"没拿到"，不是"没有版本"） */
  version: string | null
  /** 便携版安装目录（runtime/ollama-*） */
  installDir: string | null
  /** 模型文件目录（锚定平台 data/ollama-models，随 U 盘走） */
  modelsDir: string
  /** 发行包下载地址（UI 提示体积/手动下载用） */
  downloadUrl: string | null
  /** 发行包字节数（UI 体积提示） */
  downloadBytes: number | null
  /** §380：只有 `liveness==='up'` 时这份清单才有意义；消费面必须先判那一态再读它（`[]` 不等于"确实没有模型"） */
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
  | 'skills'
  | 'knowledge'
  | 'files'
  | 'notes'
  | 'translate'
  | 'image'
  | 'sandbox'
  | 'terminal'
  | 'steward'
  | 'settings'

/** 侧栏模块默认顺序（也是非法/缺项配置的回退值） */
export const DEFAULT_SIDEBAR_ORDER: SidebarModuleId[] = [
  'chat',
  'skills',
  'knowledge',
  'files',
  'notes',
  'translate',
  'image',
  'sandbox',
  'terminal',
  'steward',
  'settings'
]

/**
 * 可「固定不被休眠」的模块数上限（侧栏右键）。
 * 放在 shared 是因为 IPC 入参 schema 与渲染层 store 都要用同一个数：
 * 固定数一旦达到保活上限就等于全量豁免，LRU 失去意义，故上限取保活名额。
 */
export const MAX_PINNED_SIDEBAR_MODULES = 4

/**
 * 支持「弹出独立窗口」的模块（侧栏右键入口 + 渲染层路由 `#/detached?module=` 白名单共用）。
 * terminal / steward / settings 不在列：前者依赖主窗口的审批与设备上下文，后两者是全局面板，
 * 单独开窗没有意义。
 */
export const DETACHABLE_MODULE_IDS: SidebarModuleId[] = [
  'chat',
  'skills',
  'knowledge',
  'files',
  'notes',
  'translate',
  'image',
  'sandbox'
]

/** 清洗结果的统一形状：`changed=true` 表示原值被过滤/修补过，读取方应回写一次 app_config */
export interface SidebarPreferenceInspection {
  list: SidebarModuleId[]
  changed: boolean
}

function sameIds(raw: unknown[], list: SidebarModuleId[]): boolean {
  return raw.length === list.length && raw.every((x, i) => x === list[i])
}

/**
 * 清洗侧栏顺序（P4 批次 0）：**先按当前默认清单过滤，再校验长度/重复**。
 * 过滤优先而不是先卡长度：退役模块会残留在老用户的 `sidebar.order` 里，
 * 先过滤能把它们剔除并保住用户既有排序；长度/重复校验只拒绝真正缺项或坏数据（整体回默认）。
 * `changed` 供主进程读取侧判断是否需要「回写一次」，避免每次启动重复清洗。
 */
export function inspectSidebarOrder(
  raw: unknown,
  allowed: SidebarModuleId[] = DEFAULT_SIDEBAR_ORDER
): SidebarPreferenceInspection {
  const fallback = [...allowed]
  if (!Array.isArray(raw)) return { list: fallback, changed: false }
  const filtered = raw.filter(
    (x): x is SidebarModuleId => typeof x === 'string' && allowed.includes(x as SidebarModuleId)
  )
  const complete = filtered.length === allowed.length && new Set(filtered).size === filtered.length
  const list = complete ? filtered : fallback
  return { list, changed: !sameIds(raw, list) }
}

/**
 * 清洗「固定不被休眠」列表：剔除不存在/已退役的模块 id、去重、截断到上限。
 * 与 `sidebar.order` 同步过滤，保证 P4 摘除模块后旧配置不会留下幽灵项。
 */
export function inspectSidebarPinned(
  raw: unknown,
  allowed: SidebarModuleId[] = DEFAULT_SIDEBAR_ORDER
): SidebarPreferenceInspection {
  if (!Array.isArray(raw)) return { list: [], changed: false }
  const out: SidebarModuleId[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const id = x as SidebarModuleId
    if (!allowed.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  const list = out.slice(0, MAX_PINNED_SIDEBAR_MODULES)
  return { list, changed: !sameIds(raw, list) }
}

// ---------- 界面偏好（透明度 / 聊天字号） ----------
/** 聊天正文字号档位：small 13px / medium 14px / large 16px */
export type ChatFontSize = 'small' | 'medium' | 'large'

export interface UiPreferences {
  /** 窗口透明度 0.6–1，1 = 不透明 */
  opacity: number
  /** 聊天正文字号档位；旧数据缺省按 medium */
  chatFontSize: ChatFontSize
  /** 长代码块默认折叠阈值（行数）；0 = 永不折叠。旧数据缺省按 20 */
  codeCollapseLines: number
  /** Agent 模块上次使用的助手 id（'' = 未记/自由会话） */
  agentAssistantId: string
  /** Agent 模块上次打开的会话 id（'' = 未记；恢复时还要校验它属于那个助手） */
  agentConversationId: string
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
  /**
   * §381：探测「远端有没有这一片」没跑成的数量（超时／鉴权抖动／服务端 5xx）。
   * 它们一律走了重传＝计进 blobsUploaded，所以这里单独带出，
   * 别让「跳过 0 个」把那档「其实没探明白」演成「远端确实没有」。
   */
  blobsProbeUnknown: number
  /** 附件总数 */
  attachmentsTotal: number
  encrypted: boolean
}

// ---------- 双向合并恢复 ----------
/** 冲突处理策略：local=保留本地 / cloud=保留云端 / newer=取较新 */
export type MergeStrategy = 'local' | 'cloud' | 'newer'

/** 单表冲突统计 */
export interface MergeTableConflict {
  table: string
  /** 仅云端存在的行数（将插入本地） */
  cloudOnly: number
  /** 仅本地存在的行数（保留） */
  localOnly: number
  /** 两边都存在但内容不同的冲突行数 */
  both: number
}

/** 合并冲突扫描报告 */
export interface MergeConflictReport {
  ok: boolean
  error?: string
  tables: MergeTableConflict[]
  /** 附件将新增的数量（云端有本地无） */
  attachmentsToAdd: number
  /** 解密三态：needBackupPassword 需输入备份密码；badPassword 密码错误；legacyNoCross 旧包不支持异机 */
  code?: 'needBackupPassword' | 'badPassword' | 'legacyNoCross'
}

/** 合并执行结果（code 与 MergeConflictReport 同语义） */
export interface MergeExecuteResult {
  ok: boolean
  error?: string
  summary?: string
  code?: 'needBackupPassword' | 'badPassword' | 'legacyNoCross'
  /**
   * §315：合并把 mcp_servers 整表换成云端那份之后，运行时对账的结果（屏上那句必须说得出口）。
   * `mcpStopped`＝被摘掉的台数（记录已被云端取代或删除、或启动它的那份配置已变），其中原先在跑的已停止；
   * `reconcileFailed`＝对账本身没做成（库已经换好了，不能因此把合并报成失败），那句只能建议重启。
   */
  mcpStopped?: number
  reconcileFailed?: boolean
}

// ---------- WebDAV 备份配置与文件列表 ----------
export interface WebDAVConfig {
  url: string
  username: string
  /** 落盘＝字段加密层的密文；出 IPC 的掩码视图里若能解开则是明文（解不开时见 MaskedWebDAVConfig） */
  passwordCipher: string
  directory: string
}

/**
 * §381：WebDAV 配置出 IPC 的那份掩码视图（SEC-35 的 `••••`＋末 4 位），
 * 另带一颗「口令解不开」——它和「没配过」不是一回事：URL、用户名、同步卡片都是真的，
 * 只有那份口令在当前字段密钥下用不了（主密码轮换没跟着重写的那份＝§375 那一族的第四张快照）。
 */
export interface MaskedWebDAVConfig extends WebDAVConfig {
  passwordUndecryptable: boolean
}

export interface WebDAVBackupFile {
  /** 文件名：全量 pocketai-backup-*.zip / 增量 pocketai-inc-*.json[.enc] */
  name: string
  /** 字节数 */
  size: number
  /** 修改时间（ms 时间戳） */
  mtime: number
  /** 是否主密码加密包 */
  encrypted: boolean
  kind: 'full' | 'incremental'
}

/** WebDAV/本地恢复结果；code 驱动渲染层备份密码弹窗 */
export interface BackupRestoreResult {
  ok: boolean
  error?: string
  /** 用户取消了文件选择器（仅本地恢复） */
  canceled?: boolean
  /** needBackupPassword: 当前主密码解不开，需输入备份密码；badPassword: 密码错误可重试；legacyNoCross: v1 旧包无法异机恢复 */
  code?: 'needBackupPassword' | 'badPassword' | 'legacyNoCross'
  /** 异机密码恢复成功：主密码已变为备份时密码，应提示用户重启 */
  passwordChanged?: boolean
  /** 选中的备份文件绝对路径：密码重试时回传，避免再次弹选择器（仅本地恢复） */
  /** 待重试备份的文件名（不含目录，仅供 UI 展示）+ 主进程签发的路径令牌（SEC-6，替代回传绝对路径） */
  fileName?: string
  restoreToken?: string
}

// ---------- 定时备份 ----------
export interface BackupRunResult {
  ok: boolean
  at: number
  filename?: string
  /** 本次成功后轮转删除的旧全量包份数 */
  pruned?: number
  error?: string
}

export interface BackupScheduleStatus {
  enabled: boolean
  intervalHours: number
  /** 保留最近 N 份全量包，0=不自动清理 */
  retentionCount: number
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

/** 工作目录项目「打开所在目录」：失败时 error 形如 `CODE:中文说明`，界面按回码换四语 */
export interface ProjectOpenDirResult extends FileOpResult {
  path?: string
}

/** 工作目录项目「导出 ZIP」：取消不是错误（ok=true + canceled=true） */
export interface ProjectZipAbsResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

// ---------- 知识库内置本地 embedding ----------
/** 内置 embedding 在 KB 配置中的虚拟 provider id（providers 表中不存在，embedding 服务拦截分派） */
export const BUILTIN_EMBED_PROVIDER_ID = 'builtin'
/** 内置模型固定 model 名（与 scripts/fetch-embedding-model.mjs 下载目录一致） */
export const BUILTIN_EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'
export const BUILTIN_EMBED_DIM = 512
/** bge 中文系列检索场景的查询指令前缀（仅加在查询侧，文档侧不加） */
export const BUILTIN_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

// ---------- 出网清单（只读） ----------
// 清单由主进程注册表 OUTBOUND_ENTRIES 导出，覆盖测试按调用点文件做回归；
// 这里只描述渲染端拿到的视图，避免把「显示文案」写死在主进程。
export type OutboundKind = 'fixed' | 'configurable' | 'runtime-url' | 'local-loopback'
export type OutboundTransport =
  | 'safeFetch'
  | 'fetch'
  | 'webdav'
  | 'updater'
  | 'websocket'
  | 'child-process'

export interface OutboundAddress {
  /** 可选标签（服务商名 / MCP Server 名）；空串表示只展示地址 */
  label: string
  value: string
}

export interface OutboundEntryView {
  id: string
  /** 类别名 i18n 键 */
  labelKey: string
  /** 用途说明 i18n 键 */
  purposeKey: string
  kind: OutboundKind
  /** 固定端点常量（configurable/runtime-url 也可能列出已知的固定部分，可能为空） */
  endpoints: string[]
  transport: OutboundTransport
  /** 配置来源（如 provider baseUrl、agent.websearch_searxng_url、mcp_servers） */
  configSource: string
  /** 从现有配置仓储解析出的当前真实地址；未配置 / 读不到为空数组 */
  addresses: OutboundAddress[]
  /** 解析当前地址失败时的原因（失败不伪装成未配置） */
  resolveError?: string
}

// ---------- IPC 通道 ----------
export const IPC = {
  SYSTEM_HARDWARE_INFO: 'system:hardware-info',
  APP_GET_PATHS: 'app:get-paths',
  APP_HANDSHAKE: 'app:handshake', // V4-Iter-475：主进程能力握手（通道清单 + 构建标识），旧主进程没有它
  MENU_SET_LANGUAGE: 'menu:set-language',
  UPDATE_SET_SETTINGS: 'update:set-settings',
  DB_RUN_MIGRATIONS: 'db:run-migrations',
  DB_INTEGRITY_CHECK: 'db:integrity-check',

  PROVIDER_LIST: 'provider:list',
  PROVIDER_SAVE: 'provider:save',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_FETCH_MODELS: 'provider:fetch-models',
  PROVIDER_TEST: 'provider:test',
  /** 按需揭示单个 Provider 的真实密钥（列表已改为掩码视图，编辑/复制时显式调用） */
  PROVIDER_REVEAL_KEYS: 'provider:reveal-keys',

  ASSISTANT_LIST: 'assistant:list',
  ASSISTANT_GET: 'assistant:get',
  ASSISTANT_SAVE: 'assistant:save',
  ASSISTANT_DELETE: 'assistant:delete',
  ASSISTANT_DUPLICATE: 'assistant:duplicate',
  ASSISTANT_SET_PINNED: 'assistant:set-pinned',
  ASSISTANT_SET_ENABLED: 'assistant:set-enabled',
  ASSISTANT_EXPORT: 'assistant:export', // 导出全部用户助手为 JSON
  ASSISTANT_IMPORT: 'assistant:import', // 从 JSON 导入助手（同名覆盖）

  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  SKILL_EXPORT: 'skill:export',
  SKILL_IMPORT: 'skill:import',
  SKILL_SYNC: 'skill:sync',
  SKILL_FETCH_INDEX: 'skill:fetch-index',
  SKILL_IMPORT_URL: 'skill:import-url',
  SKILL_VALIDATE: 'skill:validate',
  SKILL_IMPORT_FOLDER: 'skill:import-folder', // §236：选一个 SKILL.md 技能目录导入（连资源文件一起快照进来）
  SKILL_LIST_FILES: 'skill:list-files', // §236：某个技能自带哪些文件
  SKILL_TEMPLATES: 'skill:templates',

  MEMORY_LIST: 'memory:list',
  MEMORY_ADD: 'memory:add',
  MEMORY_UPDATE: 'memory:update',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_RESTORE: 'memory:restore',
  MEMORY_LIST_DELETED: 'memory:list-deleted',
  MEMORY_PURGE: 'memory:purge',

  CONVERSATION_LIST: 'conversation:list',
  CONVERSATION_GET: 'conversation:get', // 单条会话：渲染层按 id 判「这是不是子代理会话」（§235）
  CONVERSATION_LIST_CHILDREN: 'conversation:listChildren', // 直接子会话：委派过程的入口（§235）
  CONVERSATION_SET_PINNED: 'conversation:set-pinned',
  CONVERSATION_SET_ARCHIVED: 'conversation:set-archived',
  CONVERSATION_CREATE: 'conversation:create',
  CONVERSATION_DELETE: 'conversation:delete',
  CONVERSATION_BATCH_DELETE: 'conversation:batch-delete',
  CONVERSATION_RENAME: 'conversation:rename',
  CONVERSATION_EXPORT_MD: 'conversation:export-md',
  CONVERSATION_EXPORT_HTML: 'conversation:export-html',
  CONVERSATION_EXPORT_PDF: 'conversation:export-pdf', // 单条导出 PDF（渲染端传自包含 HTML，主进程隐藏窗口 printToPDF）
  CONVERSATION_EXPORT_PDF_BATCH: 'conversation:export-pdf-batch', // 多选批量导出 PDF（上限 50）
  CONVERSATION_EXPORT_BATCH: 'conversation:export-batch',
  CONVERSATION_EXPORT_MESSAGES: 'conversation:export-messages', // 多选消息子集导出单个 md（渲染端传文件名+内容）
  EXPORT_PREPARE_DRAG: 'export:prepare-drag', // 导出拖拽：渲染端传文件名+内容，主进程写临时文件返回路径
  EXPORT_START_DRAG: 'export:start-drag', // 导出拖拽：dragstart 同步 send，主进程校验路径后 webContents.startDrag
  CONVERSATION_EXPORT_ENCRYPTED: 'conversation:export-enc',
  CONVERSATION_IMPORT_ENCRYPTED: 'conversation:import-enc',
  CONVERSATION_IMPORT: 'conversation:import',
  /** 外部平台记录导入（ChatGPT conversations.json / Claude JSONL；渲染端读好文本传入） */
  CONVERSATION_IMPORT_EXTERNAL: 'conversation:import-external',
  CONVERSATION_FORK: 'conversation:fork',
  CONVERSATION_SMART_TITLE_GET: 'conversation:smart-title-get',
  CONVERSATION_SMART_TITLE_SET: 'conversation:smart-title-set',
  CONVERSATION_DRAFT_GET: 'conversation:draft-get', // 读取会话未发送草稿
  CONVERSATION_DRAFT_SET: 'conversation:draft-set', // 保存草稿（空串=清除）
  CONVERSATION_DELETE_IF_EMPTY: 'conversation:delete-if-empty', // 守卫删除空会话（0消息0草稿/自动标题/未置顶）
  CONVERSATION_CLEANUP_EMPTY: 'conversation:cleanup-empty', // 启动全局清扫空会话
  CONVERSATION_GROUP_LIST: 'conversation:group-list', // 分组文件夹列表（按助手过滤）
  CONVERSATION_GROUP_CREATE: 'conversation:group-create',
  CONVERSATION_GROUP_RENAME: 'conversation:group-rename',
  CONVERSATION_GROUP_DELETE: 'conversation:group-delete', // 解散组（组内会话回到未分组，不删内容）
  CONVERSATION_SET_GROUP: 'conversation:set-group', // 移动会话到组（groupId=null 移出）
  CONVERSATION_SET_ASSISTANT: 'conversation:set-assistant', // 改归属助手（assistantId=null 回自由会话；同时清分组）
  CONVERSATION_SET_NOTE: 'conversation:set-note', // 设置会话备注（trim 空串存 NULL）
  CONVERSATION_SET_SYSTEM_PROMPT_OVERRIDE: 'conversation:set-system-prompt-override', // 设置会话级系统提示词覆盖（trim 空串存 NULL）
  CONVERSATION_SET_AGENT_MODE: 'conversation:set-agent-mode', // v57：记住本会话的 Agent 模式开关（按会话各自记住）

  WINDOW_BEHAVIOR_GET: 'window-behavior:get', // 读取窗口行为设置（开机自启/关窗到托盘）
  WINDOW_BEHAVIOR_SET_LAUNCH: 'window-behavior:set-launch', // 设置开机自启
  WINDOW_BEHAVIOR_SET_CLOSE_TO_TRAY: 'window-behavior:set-close-to-tray', // 设置关窗最小化到托盘

  MESSAGE_LIST: 'message:list',
  MESSAGE_DELETE: 'message:delete',
  MESSAGE_DELETE_BATCH: 'message:delete-batch', // 批量删除：单 IPC 删除多条消息（上限 500）
  MESSAGE_TRUNCATE_FROM: 'message:truncate-from', // 截断重跑：删除目标消息及其后全部消息
  MESSAGE_SEARCH: 'message:search',
  MESSAGE_SET_STARRED: 'message:set-starred', // 收藏星标：标记/取消重要消息
  MESSAGE_LIST_STARRED: 'message:list-starred', // 收藏列表：跨会话统一查看（时间倒序）
  MESSAGE_FORWARD: 'message:forward', // 跨会话转发：插入一条不触发 AI 的消息（targetConvId=null 新建会话）
  MESSAGE_SET_PINNED: 'message:set-pinned', // 消息置顶：会话内钉住关键消息
  USAGE_GET: 'usage:get', // 用量聚合汇总（token 用量按日/provider/模型）
  USAGE_CONVERSATIONS: 'usage:conversations', // 会话维度用量排行（标题/次数/token/费用）
  USAGE_ASSISTANTS: 'usage:assistants', // 助手维度用量排行（名称/次数/token/费用）
  USAGE_PRICING_GET: 'usage:pricing-get', // 用量单价配置读取
  USAGE_PRICING_SET: 'usage:pricing-set', // 用量单价配置保存
  USAGE_MODELS: 'usage:models', // 历史出现过的 provider/模型清单（单价编辑器用）
  USAGE_DETAIL_GET: 'usage:detail-get', // 用量行级明细（CSV 导出）
  USAGE_EXPORT_CSV: 'usage:export-csv', // 用量明细 CSV 保存文件
  USAGE_BUDGET_GET: 'usage:budget-get', // 预算状态（今日/本月已花 + 已配置预算）
  USAGE_BUDGET_SET: 'usage:budget-set', // 保存预算（null=不限制）
  USAGE_BUDGET_WARNING_EVENT: 'usage:budget-warning', // 主进程→渲染端：日/月预算达 80% 软预警（每周期一次）
  USAGE_BUDGET_STOP_EVENT: 'usage:budget-stop', // 主进程→渲染端：Agent 循环因金额预算触顶而收尾停止
  DATA_HEALTH_GET: 'dataHealth:get', // 数据健康度（体量/知识库索引状态/备份与维护任务）
  DATA_HEALTH_OPEN_DIR: 'dataHealth:open-dir', // 在系统文件管理器里打开数据目录（「浏览器缓存」那一格旁的只读跳转）
  DATA_HEALTH_CLEAR_CACHE: 'dataHealth:clear-cache', // 清 default session 的 HTTP 缓存（同那一格旁的显式动作；不做文件系统删除，见 cache-clean.ts）
  DATA_HEALTH_CLEAR_APPROVALS: 'dataHealth:clear-approvals', // 清空审批审计账本（approval_events）
  APPROVALS_LIST: 'approvals:list', // 审批明细屏（P0-2c-3）：只读分页 + 筛选，limit 由 zod 封顶
  APPROVALS_EXPORT: 'approvals:export', // 审批明细导出（P0-2c-3）：按当前筛选落 JSON/CSV，独立硬上限
  DATA_HEALTH_KB_CLEAN: 'dataHealth:kb-clean', // 清理孤儿向量/孤儿 chunk
  DATA_HEALTH_KB_DEDUP: 'dataHealth:kb-dedup', // 重复文档去重（保留指定文档，删其余）
  DATA_HEALTH_KB_REINDEX: 'dataHealth:kb-reindex', // 缺向量/维度不匹配文档一键重建索引
  // 本机判据屏（V4-Iter-146）：只读汇总"判据 + 现采显存 + 槽位现状 + 各模型委派判定"。
  // 单独一条通道而不是塞进 DATA_HEALTH_GET：这份数据的存在理由是"测得 vs 保守默认"要分开显示，
  // 与数据健康的体量口径无关，混在一屏里反而会把两种来源档糊成同一种"看起来是事实"的数。
  LOCAL_JUDGEMENT_GET: 'localJudgement:get',

  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_REGENERATE: 'chat:regenerate',
  CHAT_RESEND: 'chat:resend',
  CHAT_CHUNK_EVENT: 'chat:chunk-event',
  CHAT_DONE_EVENT: 'chat:done-event',
  CHAT_ERROR_EVENT: 'chat:error-event',
  CHAT_GET_RUNTIME_STATES: 'chat:get-runtime-states', // B-2：运行态快照（窗口挂载/聚焦时取）
  CHAT_CLEAR_RUNTIME_FAILURE: 'chat:clear-runtime-failure', // B-2：清除「失败/已中断」角标（用户打开会话时）
  CHAT_RUNTIME_STATE_EVENT: 'chat:runtime-state-event', // 主进程→渲染端：运行态/未读增量（只带身份与状态）
  CHAT_REPORT_READ_STATE: 'chat:report-read-state', // B-4：渲染端上报「聚焦+可见+未锁屏」的当前会话，主进程据此清未读
  CONVERSATION_TITLE_EVENT: 'conversation:title-event',

  KB_LIST: 'kb:list',
  KB_GET: 'kb:get',
  KB_SAVE: 'kb:save',
  KB_DELETE: 'kb:delete',

  KB_DOC_LIST: 'kb-doc:list',
  KB_DOC_ADD_FILE: 'kb-doc:add-file',
  KB_DOC_ADD_FOLDER: 'kb-doc:add-folder',
  KB_DOC_ADD_URL: 'kb-doc:add-url',
  KB_DOC_ADD_TEXT: 'kb-doc:add-text',
  KB_DOC_DELETE: 'kb-doc:delete',
  KB_DOC_REINDEX: 'kb-doc:reindex',
  /** 读取 txt 类文档原文供编辑（非 txt 或 v42 前无原文返回 null） */
  KB_DOC_GET_TEXT: 'kb-doc:get-text',
  /** 编辑 txt 类文档标题+原文（保存后自动重建索引） */
  KB_DOC_UPDATE_TEXT: 'kb-doc:update-text',
  /** 重命名任意类型文档标题（不重建索引） */
  KB_DOC_RENAME: 'kb-doc:rename',
  KB_SYNC_CHECK: 'kb:sync-check',
  /** 选一份评测集 JSON（返回 SEC-6 的对话框路径令牌 + 文件名，渲染层拿不到绝对路径） */
  KB_EVAL_PICK: 'kb:eval-pick',
  /** 按令牌指到的卷子逐条跑真检索，返回 recall@k / MRR / 漏召回与失效清单 */
  KB_EVAL_RUN: 'kb:eval-run',
  KB_DOC_SET_ENABLED: 'kb-doc:set-enabled',

  KB_CHUNK_LIST: 'kb-chunk:list',
  KB_RETRIEVE: 'kb:retrieve',
  KB_RETRIEVE_DEBUG: 'kb:retrieve-debug',
  KB_ASK: 'kb:ask',
  KB_ASK_ABORT: 'kb:ask-abort',
  KB_ASK_CHUNK_EVENT: 'kb-ask:chunk-event',
  KB_ASK_DONE_EVENT: 'kb-ask:done-event',
  KB_ASK_ERROR_EVENT: 'kb-ask:error-event',
  KB_ASK_SESSION_SAVE: 'kb-ask-session:save',
  KB_ASK_SESSION_LIST: 'kb-ask-session:list',
  KB_ASK_SESSION_GET: 'kb-ask-session:get',
  KB_ASK_SESSION_DELETE: 'kb-ask-session:delete',
  KB_ASK_SESSION_RENAME: 'kb-ask-session:rename',
  KB_ASK_SESSION_EXPORT_MD: 'kb-ask-session:export-md',
  KB_ASK_SESSION_EXPORT_HTML: 'kb-ask-session:export-html',
  KB_ASK_SESSION_SEARCH: 'kb-ask-session:search',
  KB_ASK_SESSION_LIST_ALL: 'kb-ask-session:list-all',
  KB_ASK_SESSION_SEARCH_ALL: 'kb-ask-session:search-all',
  KB_ASK_RETENTION_GET: 'kb-ask:retention-get',
  KB_ASK_RETENTION_SET: 'kb-ask:retention-set',

  // 运行期性能事件（渲染端 → 主进程上报，入环形缓冲供数据健康面板展示）
  PERF_EVENT: 'perf:event',

  // MCP Server
  MCP_SERVER_LIST: 'mcp-server:list',
  MCP_SERVER_GET: 'mcp-server:get',
  /** 按需揭示单个 Server 的 env/headers 真实值（列表已改为掩码视图） */
  MCP_SERVER_REVEAL_SECRETS: 'mcp-server:reveal-secrets',
  MCP_SERVER_SAVE: 'mcp-server:save',
  MCP_SERVER_DELETE: 'mcp-server:delete',
  /** 导出全部 MCP 配置为标准 mcpServers JSON（敏感值默认脱敏，showSaveDialog 选路径） */
  MCP_SERVER_EXPORT: 'mcp-server:export',
  MCP_SERVER_START: 'mcp-server:start',
  MCP_SERVER_STOP: 'mcp-server:stop',
  MCP_SERVER_RESTART: 'mcp-server:restart',
  MCP_SERVER_LIST_TOOLS: 'mcp-server:list-tools',
  // 手动试运行工具（面板调试用，等价于用户显式确认后执行，不走 assistant 权限链路）
  MCP_SERVER_CALL_TOOL: 'mcp-server:call-tool',
  MCP_SERVER_GET_RUNTIMES: 'mcp-server:get-runtimes', // 一次性拉取所有运行时状态
  MCP_SERVER_STATUS_EVENT: 'mcp-server:status-event',
  MCP_SERVER_LOG_EVENT: 'mcp-server:log-event',
  MCP_CALL_LOG_LIST: 'mcp:call-log-list', // 读历史调用记录（可按 server 过滤）
  MCP_CALL_LOG_CLEAR: 'mcp:call-log-clear', // 清空调用记录（传 serverId 只清该 server）

  // ---------- 终端模块（用户手动交互式终端，非 Agent 工具） ----------
  TERMINAL_START: 'terminal:start',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_OUTPUT: 'terminal:output', // 主进程 → 渲染端输出推送

  // ---------- 笔记 ----------
  NOTES_LIST: 'notes:list',
  NOTES_GET: 'notes:get',
  NOTES_CREATE: 'notes:create',
  NOTES_UPDATE: 'notes:update',
  NOTES_DELETE: 'notes:delete',
  NOTES_SEARCH: 'notes:search',
  NOTES_CREATE_FROM_MESSAGE: 'notes:create-from-message',

  // ---------- 提示词片段 ----------
  SNIPPETS_LIST: 'snippets:list',
  SNIPPETS_CREATE: 'snippets:create',
  SNIPPETS_UPDATE: 'snippets:update',
  SNIPPETS_DELETE: 'snippets:delete',
  SNIPPETS_EXPORT: 'snippets:export',
  SNIPPETS_IMPORT: 'snippets:import',

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
  /** 灯箱：图片 data URL 写系统剪贴板 / 另存为本地文件 */
  CLIPBOARD_WRITE_IMAGE: 'clipboard:write-image',
  IMAGE_SAVE_DATAURL: 'images:save-dataurl',

  // ---------- 沙箱（v2 批次八：沙箱基础层） ----------
  SANDBOX_LIST: 'sandbox:list',
  SANDBOX_CREATE: 'sandbox:create',
  SANDBOX_GET: 'sandbox:get',
  SANDBOX_DELETE: 'sandbox:delete',
  SANDBOX_UPDATE_META: 'sandbox:update-meta',

  // Work Agent
  AGENT_RUN: 'agent:run',
  AGENT_ABORT: 'agent:abort',
  AGENT_INTERJECT: 'agent:interject', // 运行中插队：只在主干 run 的步边界被消费
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
  AGENT_GET_LATEST_RUN_STATS: 'agent:get-latest-run-stats', // 会话最近一次运行统计（trace 聚合，只读）
  AGENT_GET_RUN_STATS: 'agent:get-run-stats', // §398：**按这一次运行**（requestId）取统计，不按会话取最近一次（只读）
  AGENT_GET_LATEST_RUN_TRACES: 'agent:get-latest-run-traces', // 会话最近一次运行分步明细（只读）
  AGENT_GET_RUN_TRACES: 'agent:get-run-traces', // §398：**按这一次运行**（requestId）取分步明细，与「本次运行统计」同一条口径（只读）
  AGENT_GET_SESSION_STATS: 'agent:get-session-stats', // 会话级累计统计（跨全部运行聚合，只读）
  AGENT_LIST_RUNS: 'agent:list-runs', // P2：会话全部 run 索引（只读，按 request_id 聚合后映射轮次）
  AGENT_GET_TEXT_PROTOCOL: 'agent:get-text-protocol', // 被点名走文本协议的模型清单（只读）
  AGENT_SET_TEXT_PROTOCOL: 'agent:set-text-protocol', // 开/关某台模型的文本协议
  AGENT_GET_TOOL_SURFACE: 'agent:get-tool-surface', // 工具面装载模式（grouped / full，只读）
  AGENT_SET_TOOL_SURFACE: 'agent:set-tool-surface', // 切换工具面装载模式（全局，不建表）
  AGENT_LIST_DELEGATE_CAPS: 'agent:list-delegate-caps', // 已判出的"能不能当管控者"清单（只读，带 stale）
  AGENT_PROBE_DELEGATE_CAP: 'agent:probe-delegate-cap', // 对一台模型跑一次委派探针（会发真请求，用户点出来的）
  AGENT_ABORT_DELEGATE_PROBE: 'agent:abort-delegate-probe', // §246：停止正在跑的那一发探针（不下结论、不改写判定）
  AGENT_SET_DELEGATE_ENABLED: 'agent:set-delegate-enabled', // 决策③：点名允许某台模型顺序委派（默认关）
  AGENT_RESTORE_FILE_WRITE: 'agent:restore-file-write', // §231：把一次 fs_write 还原到写入前（按快照 id）
  AGENT_SNAPSHOTS_EXIST: 'agent:snapshots-exist', // P0-5 第三批：批量判「本机还有没有这几份快照」（只读，供结果卡点击前禁用还原）
  AGENT_GET_MODEL_WINDOWS: 'agent:get-model-windows', // §234：每台模型声明的上下文窗口（token），只读
  AGENT_SET_MODEL_WINDOW: 'agent:set-model-window', // §234：设/清一台模型的上下文窗口，回传最新表
  AGENT_GET_FALLBACKS: 'agent:get-fallbacks', // §237：每台模型的备用 target（`providerId::model` → 一台），只读
  AGENT_SET_FALLBACK: 'agent:set-fallback', // §237：设/清某台模型的备用，回传最新表

  // ---------- License 授权（商业版） ----------
  LICENSE_ACTIVATE: 'license:activate',
  LICENSE_IMPORT_FILE: 'license:import-file',

  // ---------- 独立窗口（标签弹出） ----------
  APP_OPEN_DETACHED: 'app:open-detached',
  AGENT_TOOL_APPROVAL_EVENT: 'agent:tool-approval-event',
  AGENT_TOOL_APPROVE_RESPONSE: 'agent:tool-approve-response',
  AGENT_APPROVAL_AUDIT_WARN_EVENT: 'agent:approval-audit-warn', // 主进程→渲染端：审批审计写失败（只提示，不阻断）

  // ---------- Channels（IM Bot 网关：Telegram/飞书/钉钉/Slack/Discord） ----------
  CHANNEL_GET_CONFIG: 'channel:get-config',
  CHANNEL_SET_CONFIG: 'channel:set-config',
  CHANNEL_START: 'channel:start',
  CHANNEL_STOP: 'channel:stop',
  CHANNEL_STATUS_EVENT: 'channel:status-event',
  CHANNEL_LIST_STATUS: 'channel:list-status',

  // ---------- 快捷浮窗（快捷问答 / 选区助手） ----------
  POPUP_HIDE: 'popup:hide',
  POPUP_OPEN_SELECTION: 'popup:open-selection',
  POPUP_GET_PAYLOAD: 'popup:get-payload',
  POPUP_GET_CONFIG: 'popup:get-config',
  POPUP_SET_CONFIG: 'popup:set-config',
  POPUP_PAYLOAD_EVENT: 'popup:payload-event',

  // ---------- 界面偏好 ----------
  UI_GET_PREFS: 'ui:get-prefs',
  UI_SET_PREFS: 'ui:set-prefs',
  UI_GET_THEME: 'ui:get-theme',
  UI_SET_THEME: 'ui:set-theme',
  UI_REPORT_THEME: 'ui:report-theme', // 渲染端首帧前上报当前生效主题（不改 KV，只让主进程先改窗口底色）

  // ---------- 回复完成系统通知 ----------
  NOTIFY_REPLY_GET: 'notify:reply-get',
  NOTIFY_REPLY_SET: 'notify:reply-set',
  NOTIFY_REPLY_SHOW: 'notify:reply-show', // 渲染端请求弹原生通知（主进程统一发，点击聚焦主窗口）

  // ---------- 网络代理（主进程 API 流量） ----------
  NET_PROXY_GET: 'net:proxy-get', // 读取当前代理 URL（''=直连）
  NET_PROXY_SET: 'net:proxy-set', // 保存并立即应用代理（''=恢复直连）
  OUTBOUND_GET: 'net:outbound-get', // 只读出网清单：注册表 + 各条当前真实地址

  // ---------- 侧栏模块顺序与固定 ----------
  SIDEBAR_GET_ORDER: 'sidebar:get-order',
  SIDEBAR_SET_ORDER: 'sidebar:set-order',
  SIDEBAR_GET_PINNED: 'sidebar:get-pinned',
  SIDEBAR_SET_PINNED: 'sidebar:set-pinned',

  // 工具（只读）
  TOOL_LIST_AVAILABLE: 'tool:list-available', // 列出所有可用工具（按助手机器权限可在外层过滤）
  TOOL_POLICY_SNAPSHOT: 'tool:policy-snapshot', // 只读策略总览：判定值来自 registry 同一处

  // ---------- License 授权 ----------
  LICENSE_GET_STATUS: 'license:get-status',
  LICENSE_LOAD_FILE: 'license:load-file', // 传入 license.lic 文件路径
  LICENSE_LOAD_STRING: 'license:load-string', // 传入 license 字符串
  LICENSE_CLEAR: 'license:clear',
  LICENSE_HAS_FEATURE: 'license:has-feature',
  LICENSE_GET_FINGERPRINT: 'license:get-fingerprint', // 本机硬盘指纹（16 位 hex，可能 null）
  LICENSE_ONLINE_ACTIVATE: 'license:online-activate', // 卡密在线激活（附带本机指纹请求激活服务器）

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
  ENCRYPTION_AUTH_STATUS: 'encryption:auth-status', // 查询解锁/恢复的主进程限流锁定状态
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
  WIZARD_GET_LAST_PROVIDER: 'wizard:get-last-provider', // 读取向导上次保存的 provider id
  WIZARD_SET_LAST_PROVIDER: 'wizard:set-last-provider', // 写入向导选中的 provider id（对话默认回填用）

  // ---------- 备份 ----------
  BACKUP_LOCAL: 'backup:local', // 本地备份（可选加密）
  BACKUP_LOCAL_ENCRYPTED: 'backup:local-encrypted', // 本地加密备份
  BACKUP_LOCAL_RESTORE: 'backup:local-restore', // 从本地备份文件恢复（主进程弹文件选择器）
  BACKUP_WEBDAV_TEST: 'backup:webdav-test', // 测试 WebDAV 连接
  BACKUP_WEBDAV_UPLOAD: 'backup:webdav-upload', // 上传全量备份到 WebDAV
  BACKUP_WEBDAV_UPLOAD_INCREMENTAL: 'backup:webdav-upload-incremental', // 增量备份（附件去重）
  BACKUP_WEBDAV_LIST: 'backup:webdav-list', // 列出 WebDAV 上的备份
  BACKUP_WEBDAV_RESTORE: 'backup:webdav-restore', // 从 WebDAV 恢复
  BACKUP_WEBDAV_MERGE_SCAN: 'backup:webdav-merge-scan', // 扫描云端备份与本地的冲突
  BACKUP_WEBDAV_MERGE_EXECUTE: 'backup:webdav-merge-execute', // 执行双向合并恢复
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

  // ---------- Agent 定时提醒 ----------
  REMINDER_FIRED: 'reminder:fired',
  /** 用户直建提醒（消息右键「提醒我」；Agent 工具走 reminder_set 不经此 IPC） */
  REMINDER_CREATE: 'reminder:create',
  /** 待发提醒列表（主窗口提醒中心；Agent 工具的 list 走引擎不经此） */
  REMINDER_LIST: 'reminder:list',
  /** 取消待发提醒（仅 pending 可撤） */
  REMINDER_CANCEL: 'reminder:cancel',
  /** 重新安排历史提醒（missed/cancelled 行「重新安排」回 pending） */
  REMINDER_RESCHEDULE: 'reminder:reschedule',
  /** 编辑 pending 提醒（改时间/文本/循环规则） */
  REMINDER_UPDATE: 'reminder:update',
  /** 一键重新安排 missed 循环提醒（按原 rule 重算下次触发时间回 pending） */
  REMINDER_RESCHEDULE_NEXT: 'reminder:reschedule-next',

  // ---------- 平台管家 ----------
  HEALTH_REPORT: 'health:report',
  HEALTH_CLEANUP: 'health:cleanup',
  HEALTH_VACUUM: 'health:vacuum',
  STEWARD_MODEL_RECOMMEND: 'steward:model-recommend', // 按硬件画像推荐本地模型
  STEWARD_AUDIT: 'steward:audit', // 安全检测
  STEWARD_DIAGNOSE: 'steward:diagnose', // 故障诊断
  STEWARD_VERIFY_BACKUP: 'steward:verify-backup', // 立即跑一次备份完整性校验（回三态）
  STEWARD_EXPORT_REPORT: 'steward:export-report', // 诊断报告导出为文本文件

  // ---------- 文件模块 ----------
  FILE_LIST: 'file:list',
  FILE_READ: 'file:read',
  FILE_UPLOAD: 'file:upload',
  FILE_MKDIR: 'file:mkdir',
  FILE_DELETE: 'file:delete',
  FILE_SAVE_AS: 'file:save-as',
  FILE_OPEN_LOCATION: 'file:open-location',
  FILE_OPEN_EXTERNAL: 'file:open-external',

  // ---------- 成品文件（v67） ----------
  /** 列表；参数为可选 conversationId */
  ARTIFACT_LIST: 'artifact:list',
  /** 预览（pptx 只给文字大纲，md 给正文） */
  ARTIFACT_PREVIEW: 'artifact:preview',
  ARTIFACT_DELETE: 'artifact:delete',
  /** 读产物全文（md 导出 PDF 用；超限拒绝，不截断） */
  ARTIFACT_READ_TEXT: 'artifact:read-text',
  /** 导出 PDF（渲染端给自包含 HTML，主进程 printToPDF 后落用户选择的位置；不入库） */
  ARTIFACT_EXPORT_PDF: 'artifact:export-pdf',

  // ---------- 多文件项目（v70） ----------
  /** 预览：文件清单 + index.html / README.md 文本（不承诺整站预览） */
  PROJECT_PREVIEW: 'project:preview',
  /** 撤销本次生成：所有文件哈希仍一致才删目录 */
  PROJECT_DELETE: 'project:delete',
  /** 导出 ZIP（只写不读） */
  PROJECT_EXPORT_ZIP: 'project:export-zip',
  /**
   * 工作目录项目的「打开所在目录」：入参是**绝对路径**，主进程重新 realpath 校验
   * 落在 Agent 工作目录内才打开——渲染层传来的值一律不信任。
   */
  PROJECT_OPEN_DIR: 'project:open-dir',
  /** 工作目录项目的「导出 ZIP」：按绝对路径打包 + 保存框（只写不读、不入库） */
  PROJECT_EXPORT_ZIP_ABS: 'project:export-zip-abs'
} as const
