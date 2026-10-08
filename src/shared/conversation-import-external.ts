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

export interface ExternalParseResult {
  conversations: ExternalConversation[]
  /** 因无有效消息/超限被整体跳过的会话数 */
  skippedConversationCount: number
  /** 人类可读告警（截断等），IPC 层再限前 5 条 */
  warnings: string[]
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

/** 解析单个 ChatGPT 会话对象；无有效消息返回 null */
function parseChatGptConversation(
  raw: Record<string, unknown>,
  addWarning: (w: string) => void
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
    if (!msg) continue
    const role = msg.author?.role
    if (role !== 'user' && role !== 'assistant') continue
    if (msg.content?.content_type && msg.content.content_type !== 'text') continue
    const text = truncate(textFromChatGptParts(msg.content?.parts).trim())
    if (!text) continue
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
      addWarning('ChatGPT 会话消息超过上限，已截断保留最早 10000 条')
      break
    }
  }
  if (messages.length === 0) return null

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'ChatGPT 对话'
  return { title, ...(convCreated ? { createdAt: convCreated } : {}), messages, source: 'chatgpt' }
}

/** 解析 ChatGPT conversations.json 文本 */
export function parseChatGptExport(text: string): ExternalParseResult {
  const warnings: string[] = []
  const addWarning = (w: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(w)
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return { conversations: [], skippedConversationCount: 0, warnings: ['不是有效的 JSON 文件'] }
  }
  if (!Array.isArray(root)) {
    return { conversations: [], skippedConversationCount: 0, warnings: ['ChatGPT 导出文件顶层应为数组'] }
  }

  const conversations: ExternalConversation[] = []
  let skipped = 0
  for (const item of root) {
    if (conversations.length >= MAX_EXTERNAL_CONVERSATIONS) {
      skipped += root.length - conversations.length - skipped
      addWarning(`会话数超过上限 ${MAX_EXTERNAL_CONVERSATIONS}，多余会话已跳过`)
      break
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      skipped++
      continue
    }
    const conv = parseChatGptConversation(item as Record<string, unknown>, addWarning)
    if (conv) conversations.push(conv)
    else skipped++
  }
  return { conversations, skippedConversationCount: skipped, warnings }
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
  return parts.join('\n')
}

/**
 * 解析单个 Claude JSONL 文件文本（一个文件 = 一个会话）。
 * @param fallbackTitle 文件名（去扩展名），无法从内容推断标题时使用
 */
export function parseClaudeJsonl(text: string, fallbackTitle: string): ExternalParseResult {
  const warnings: string[] = []
  const messages: ExternalMessage[] = []
  let convCreated: number | undefined
  let truncated = false

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      row = parsed as Record<string, unknown>
    } catch {
      // 坏行不阻断（导出文件可能混入非对话行）
      continue
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue
    const inner =
      typeof row.message === 'object' && row.message !== null
        ? (row.message as Record<string, unknown>)
        : undefined
    const content = row.content ?? inner?.content
    const raw = textFromClaudeContent(content, row)
    if (raw === null) continue
    const contentText = truncate(raw.trim())
    if (!contentText) continue

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
    return { conversations: [], skippedConversationCount: 1, warnings: [] }
  }
  if (truncated) warnings.push('Claude 会话消息超过上限，已截断保留最早 10000 条')
  const title = fallbackTitle.trim() || 'Claude 对话'
  return {
    conversations: [{ title, ...(convCreated ? { createdAt: convCreated } : {}), messages, source: 'claude' }],
    skippedConversationCount: 0,
    warnings
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
