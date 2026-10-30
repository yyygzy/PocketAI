// 外部 AI 对话记录导入解析（无 electron 依赖，直接 vitest）。
//
// 支持：
//   ChatGPT 官方导出 conversations.json —— 顶层数组，每条含 mapping 消息树
//   （current_node/author.role/content.parts/metadata.model_slug），线性化取主干；
//   Claude 导出/CLI 的 JSONL —— 每行 user/assistant 事件，content 为字符串或
//   [{type:'text',text}] 块数组，兼容网页端（顶层 content）与 CLI（message.content）。
//
// 安全边界：只收 user/assistant 文本消息；图片/工具调用/思维链/system 一律丢弃；
// 会话数、每会话消息数、单条字符数均有上限，防伪造大文件撑爆内存/库。

export type ExternalSource = 'chatgpt' | 'claude'

export interface ExternalMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt?: number
  model?: string
}

export interface ExternalConversation {
  title: string
  createdAt?: number
  messages: ExternalMessage[]
  source: ExternalSource
}

/**
 * 消息级丢弃的四类计数（**会话级丢弃不在这里**，那是 skippedConversationCount）。
 * 分四类而不是一句总数：真实导出文件里「非消息节点」是常态（Claude CLI 里有 system/summary 行），
 * 把它们与「整行 JSON 读不出来」混成一个数＝把文件说成坏了。
 */
export interface ExternalDroppedMessages {
  /** 整行 JSON 解析不出来（只有逐行格式才会命中） */
  badJson: number
  /** 结构上不是可当消息的事件/节点（非对象、type 或 role 不是 user/assistant） */
  notEvent: number
  /** 是对话事件但正文不是文本（工具包裹、isMeta、content_type 非 text、没有 text 块） */
  nonText: number
  /** 文本取到了但是空的 */
  emptyText: number
}

export function emptyDroppedMessages(): ExternalDroppedMessages {
  return { badJson: 0, notEvent: 0, nonText: 0, emptyText: 0 }
}

export function droppedMessageTotal(d: ExternalDroppedMessages): number {
  return d.badJson + d.notEvent + d.nonText + d.emptyText
}

/**
 * 导入告警的回码（V4-Iter-370）。此前这些串是主进程/shared 里的手抄中文，
 * 而 `ChatModule.tsx` 把它原样 `toast.error` 出去 ⇒ 英/日/韩界面在这一格夹一句中文。
 * 口径同 §206：中文尾段留给日志，界面只认冒号前那个码（登记表在渲染层）。
 */
export type ExternalWarningCode =
  | 'IMPORT_FILE_NOT_JSON'
  | 'IMPORT_NOT_ARRAY'
  | 'IMPORT_CONV_LIMIT'
  | 'IMPORT_MSG_LIMIT'
  | 'IMPORT_UNKNOWN_FORMAT'
  | 'IMPORT_WRITE_FAILED'

export interface ExternalWarning {
  code: ExternalWarningCode
  /** 句子要填的槽（上限值、原始错误文本…）；渲染层按字典里的占位符逐个取 */
  args?: Record<string, string | number>
  /** 这一发是在哪个文件／哪个会话上出的（用户数据，不进字典，由渲染层用四语的间隔符拼上去） */
  where?: string
}

export interface ExternalParseResult {
  conversations: ExternalConversation[]
  /** 因无有效消息/超限被整体跳过的会话数 */
  skippedConversationCount: number
  /** 告警（截断等），IPC 层再限前 5 条 */
  warnings: ExternalWarning[]
  /** 消息级丢弃计数：屏上那句「导入 N 条消息」之外少掉的部分 */
  droppedMessages: ExternalDroppedMessages
}

export const MAX_EXTERNAL_CONVERSATIONS = 1000
export const MAX_EXTERNAL_MESSAGES_PER_CONV = 10_000
export const MAX_EXTERNAL_CONTENT_CHARS = 100_000

/** 解析器内部告警上限，防异常文件产生海量告警 */
const MAX_WARNINGS = 20

/** 秒/毫秒自适应 → 毫秒 */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return undefined
}

function truncate(text: string): string {
  return text.length > MAX_EXTERNAL_CONTENT_CHARS ? text.slice(0, MAX_EXTERNAL_CONTENT_CHARS) : text
}

interface ChatGptNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: {
    author?: { role?: string }
    create_time?: number | null
    content?: { content_type?: string; parts?: unknown }
    metadata?: { model_slug?: string } | null
  } | null
}

/**
 * 从 mapping 树提取主干节点（根→叶）。
 * 优先沿 current_node 经 parent 回溯（忠实当前活跃分支，忽略编辑/重新生成的旁支）；
 * current_node 缺失/非法时回退到根节点 DFS 第一个叶子；visited 防环。
 */
function extractTrunk(mapping: Record<string, ChatGptNode>, currentNode?: string | null): ChatGptNode[] {
  const path: ChatGptNode[] = []
  const visited = new Set<string>()

  if (currentNode && mapping[currentNode]) {
    let curId: string | undefined | null = currentNode
    while (curId && mapping[curId]) {
      if (visited.has(curId)) break
      visited.add(curId)
      path.push(mapping[curId]!)
      curId = mapping[curId]!.parent ?? null
    }
    path.reverse()
    if (path.length > 0) return path
  }

  // 回退：parent 为 null/不在 mapping 中的节点为根，沿第一个孩子下行
  const root = Object.values(mapping).find(
    (n) => n.parent == null || (typeof n.parent === 'string' && !mapping[n.parent])
  )
  let node: ChatGptNode | undefined = root
  const seen = new Set<string>()
  while (node) {
    const key = node.id ?? ''
    if (seen.has(key)) break
    seen.add(key)
    path.push(node)
    const nextId = Array.isArray(node.children) ? node.children[0] : undefined
    node = nextId ? mapping[nextId] : undefined
  }
  return path
}

function textFromChatGptParts(parts: unknown): string {
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  // 图片/多模态部分是对象（content_type=multimodal_text 时），只取字符串片段
  return parts.filter((p): p is string => typeof p === 'string').join('\n')
}

/** 解析单个 ChatGPT 会话对象；无有效消息返回 null（节点级的丢弃逐类计入 dropped） */
function parseChatGptConversation(
  raw: Record<string, unknown>,
  addWarning: (w: ExternalWarning) => void,
  dropped: ExternalDroppedMessages
): ExternalConversation | null {
  const mapping = raw.mapping
  if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) return null

  const nodes = extractTrunk(
    mapping as Record<string, ChatGptNode>,
    typeof raw.current_node === 'string' ? raw.current_node : null
  )

  const messages: ExternalMessage[] = []
  const convCreated = toMs(raw.create_time)
  let seq = 0
  for (const node of nodes) {
    const msg = node.message
    // mapping 树上没有 message 的节点是**结构节点**（树根、旁支衔接点），不是一条被丢掉的内容 ⇒ 不计数。
    // 把它算进 notEvent 会让一份完全正常的导出凭空多出几条"丢弃"（本批第一版就是这么写的，被 D11 逼出来的）。
    if (!msg) continue
    const role = msg.author?.role
    if (role !== 'user' && role !== 'assistant') {
      dropped.notEvent++
      continue
    }
    if (msg.content?.content_type && msg.content.content_type !== 'text') {
      dropped.nonText++
      continue
    }
    const text = truncate(textFromChatGptParts(msg.content?.parts).trim())
    if (!text) {
      dropped.emptyText++
      continue
    }
    const createdAt = toMs(msg.create_time) ?? convCreated
    messages.push({
      role,
      content: text,
      ...(createdAt ? { createdAt: createdAt + seq } : {}),
      ...(typeof msg.metadata?.model_slug === 'string' && msg.metadata.model_slug
        ? { model: msg.metadata.model_slug }
        : {})
    })
    seq++
    if (messages.length >= MAX_EXTERNAL_MESSAGES_PER_CONV) {
      addWarning({ code: 'IMPORT_MSG_LIMIT', args: { max: MAX_EXTERNAL_MESSAGES_PER_CONV } })
      break
    }
  }
  if (messages.length === 0) return null

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'ChatGPT 对话'
  return { title, ...(convCreated ? { createdAt: convCreated } : {}), messages, source: 'chatgpt' }
}

/** 解析 ChatGPT conversations.json 文本 */
export function parseChatGptExport(text: string): ExternalParseResult {
  const warnings: ExternalWarning[] = []
  const addWarning = (w: ExternalWarning) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(w)
  }
  // 整份文件读不出来／顶层不是数组＝一个消息都没看过，dropped 保持全 0（这种文件走告警那一路，
  // 不混进"逐条丢弃"的数里——那会把整份文件说成几千条坏行）
  const dropped = emptyDroppedMessages()
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { conversations: [], skippedConversationCount: 0, warnings: [{ code: 'IMPORT_FILE_NOT_JSON' }], droppedMessages: dropped }
  }
  if (!Array.isArray(root)) {
    return { conversations: [], skippedConversationCount: 0, warnings: [{ code: 'IMPORT_NOT_ARRAY' }], droppedMessages: dropped }
  }

  const conversations: ExternalConversation[] = []
  let skipped = 0
  for (const item of root) {
    if (conversations.length >= MAX_EXTERNAL_CONVERSATIONS) {
      skipped += root.length - conversations.length - skipped
      addWarning({ code: 'IMPORT_CONV_LIMIT', args: { max: MAX_EXTERNAL_CONVERSATIONS } })
      break
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      skipped++
      continue
    }
    const conv = parseChatGptConversation(item as Record<string, unknown>, addWarning, dropped)
    if (conv) conversations.push(conv)
    else skipped++
  }
  return { conversations, skippedConversationCount: skipped, warnings, droppedMessages: dropped }
}

/** Claude content 块（数组）/字符串 → 纯文本；返回 null 表示该消息应整体跳过（工具包裹） */
function textFromClaudeContent(content: unknown, row: Record<string, unknown>): string | null {
  // toolResult/isMeta 包裹的 user 行（CLI 工具回填），不是真实用户发言
  if (row.isMeta === true) return null
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  if (content.some((b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result')) {
    return null
  }
  const parts = content
    .filter(
      (b): b is { type: string; text?: unknown } =>
        typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
    )
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
  // 有块、但一块 text 都没有（thinking／图片）＝"正文不是文本"，不是"正文为空"：
  // 报成后者会让人以为导出缺了内容，而它本来就不是可存的文本
  if (content.length > 0 && parts.length === 0) return null
  return parts.join('\n')
}

/**
 * 解析单个 Claude JSONL 文件文本（一个文件 = 一个会话）。
 * @param fallbackTitle 文件名（去扩展名），无法从内容推断标题时使用
 */
export function parseClaudeJsonl(text: string, fallbackTitle: string): ExternalParseResult {
  const warnings: ExternalWarning[] = []
  const dropped = emptyDroppedMessages()
  const messages: ExternalMessage[] = []
  let convCreated: number | undefined
  let truncated = false

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    // 空行是排版、不是"一条没被认出的内容"，一类都不计（否则一份正常文件会报出一堆假丢弃）
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        dropped.notEvent++
        continue
      }
      row = parsed as Record<string, unknown>
    } catch {
      // 坏行不阻断（导出文件可能混入非对话行），但要数下来——屏上那句「导入 N 条」少的就是这些
      dropped.badJson++
      continue
    }
    if (row.type !== 'user' && row.type !== 'assistant') {
      dropped.notEvent++
      continue
    }
    const inner =
      typeof row.message === 'object' && row.message !== null
        ? (row.message as Record<string, unknown>)
        : undefined
    const content = row.content ?? inner?.content
    const raw = textFromClaudeContent(content, row)
    if (raw === null) {
      dropped.nonText++
      continue
    }
    const contentText = truncate(raw.trim())
    if (!contentText) {
      dropped.emptyText++
      continue
    }

    const ts = toMs(row.timestamp ?? inner?.timestamp)
    if (ts && !convCreated) convCreated = ts
    messages.push({
      role: row.type,
      content: contentText,
      ...(ts ? { createdAt: ts } : {}),
      ...(typeof (row.model ?? inner?.model) === 'string'
        ? { model: String(row.model ?? inner?.model) }
        : {})
    })
    if (messages.length >= MAX_EXTERNAL_MESSAGES_PER_CONV) {
      truncated = true
      break
    }
  }

  if (messages.length === 0) {
    // 整份没出一条消息＝会话级跳过（skipped 那一格已有数），但逐条丢弃的数仍要带回：
    // 「这个文件里 40 行读不出来」正是这一格现在屏上没有说的话
    return { conversations: [], skippedConversationCount: 1, warnings: [], droppedMessages: dropped }
  }
  if (truncated) warnings.push({ code: 'IMPORT_MSG_LIMIT', args: { max: MAX_EXTERNAL_MESSAGES_PER_CONV } })
  const title = fallbackTitle.trim() || 'Claude 对话'
  return {
    conversations: [{ title, ...(convCreated ? { createdAt: convCreated } : {}), messages, source: 'claude' }],
    skippedConversationCount: 0,
    warnings,
    droppedMessages: dropped
  }
}

/** 格式探测结果：chatgpt / claude-jsonl（JSONL 无独立 source 枚举，归入 claude 解析器）/ null */
export type ExternalDetectedFormat = 'chatgpt' | 'claude-jsonl' | null

/** 格式探测：chatgpt（JSON 数组含 mapping）/ claude-jsonl（逐行 user/assistant 事件）/ null */
export function detectExternalFormat(text: string): ExternalDetectedFormat {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const root: unknown = JSON.parse(trimmed)
      if (Array.isArray(root) && root.some(
        (x) => typeof x === 'object' && x !== null && 'mapping' in (x as Record<string, unknown>)
      )) {
        return 'chatgpt'
      }
    } catch {
      // 落到 JSONL 探测
    }
  }
  // JSONL：扫前若干非空行，存在可解析的 user/assistant 事件即认定
  let scanned = 0
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (++scanned > 20) break
    try {
      const row: unknown = JSON.parse(t)
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      if ((r.type === 'user' || r.type === 'assistant') && (r.content !== undefined || r.message !== undefined)) {
        return 'claude-jsonl'
      }
    } catch {
      // 继续试下一行
    }
  }
  return null
}
