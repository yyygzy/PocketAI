// Agent 模块共享：类型、常量与纯函数（MCP 面板 / Agent 对话 / Channels 共用）
import type { ChatAttachment, MessageRecord, TodoItem, ToolCall, ToolResult, MessageSource } from '../../../../shared/types'

export type Tab = 'agent' | 'servers' | 'channels'

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  reasoning?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  todos?: TodoItem[] // 任务清单卡片（todo_write 步骤，随每次调用整卡更新）
  stepIndex?: number
  isFinal?: boolean
  isError?: boolean
  attachments?: ChatAttachment[]
  /** 知识库引用来源（RAG 检索命中的 chunk） */
  sources?: MessageSource[]
  dbId?: string // 对应 DB message.id（用于删除单条消息；live 占位卡需等主进程回传）
}

/**
 * 「重新生成」：给定某条助手消息，定位它之前最近一条可重跑的用户消息（卡片 id）。
 * 可重跑条件：role=user、有 dbId（已持久化才能截断）、文本非空。
 * 找不到返回 null（如运行中的占位卡、前面全是工具卡）。
 */
export function findRerunSourceId(messages: AgentMessage[], assistantId: string): string | null {
  const idx = messages.findIndex((m) => m.id === assistantId)
  if (idx <= 0) return null
  for (let i = idx - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.dbId && m.text.trim()) return m.id
  }
  return null
}

// ---------- 斜杠快捷指令 ----------

export interface SlashCommand {
  /** 触发词，不含 /（如 summary） */
  name: string
  /** 菜单显示名（i18n） */
  label: string
  /** 选中后填入输入框的提示模板（i18n） */
  template: string
}

/**
 * 解析输入框当前是否处于斜杠指令输入态。
 * 规则：去掉前导空白后以 / 开头，且 / 之后不含空白与第二个 /（单个命令词）。
 * @returns 命令词（可能为空串，表示刚敲入 /）；非指令态返回 null
 */
export function getSlashQuery(input: string): string | null {
  const m = /^\s*\/([^\s/]*)$/.exec(input)
  return m ? (m[1] ?? '') : null
}

/** 按命令词前缀过滤（大小写不敏感）；query 为空时返回全部 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => c.name.toLowerCase().startsWith(q))
}

/** 工具调用参数 JSON 美化；非合法 JSON 原样返回 */
function prettyJson(raw: string | undefined): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * 把内存中的 Agent 消息序列化为 Markdown（供一键复制；文件导出走主进程 renderConversationToMarkdown）。
 * - user/assistant：正文原文保留（可能本身含 Markdown）
 * - tool：工具名 + 参数/输出代码块；错误标记
 * - 流式占位空卡（无正文/无工具信息）跳过
 */
export function agentMessagesToMarkdown(messages: AgentMessage[], title: string): string {
  const lines: string[] = [`# ${title}`, '']
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = m.toolResult?.name ?? m.toolCall?.function.name ?? 'tool'
      lines.push(`## 🔧 工具：${name}`, '')
      const args = m.toolResult?.arguments ?? m.toolCall?.function.arguments
      if (args) {
        lines.push('**参数：**', '', '```json', prettyJson(args), '```', '')
      }
      if (m.toolResult?.content) {
        if (m.toolResult.isError) lines.push('**结果（错误）：**', '')
        lines.push('```', m.toolResult.content, '```', '')
      }
      lines.push('---', '')
      continue
    }

    const label = m.role === 'user' ? '👤 用户' : '🤖 助手'
    const hasBody =
      m.text.trim() ||
      (m.attachments && m.attachments.length > 0)
    if (!hasBody) continue

    lines.push(`## ${label}`, '')
    if (m.attachments && m.attachments.length > 0) {
      for (const a of m.attachments) {
        lines.push(`- 📎 ${a.name}${a.type === 'image' ? '（图片）' : ''}`)
      }
      lines.push('')
    }
    if (m.isError) lines.push('> ⚠️ 该消息生成失败', '')
    if (m.text.trim()) lines.push(m.text.trim(), '')
    lines.push('---', '')
  }
  return lines.join('\n')
}

// ---------- 会话内消息搜索 ----------

export interface MessageSearchHit {
  /** 命中消息在 messages 数组中的下标（时间顺序） */
  index: number
  /** 命中消息 id */
  id: string
  /** 命中角色 */
  role: AgentMessage['role']
}

/** 取出消息参与搜索的全部文本（正文 + 工具名/参数/输出） */
function searchableText(m: AgentMessage): string {
  const parts = [m.text]
  if (m.toolCall) parts.push(m.toolCall.function.name, m.toolCall.function.arguments)
  if (m.toolResult) parts.push(m.toolResult.name, m.toolResult.arguments ?? '', m.toolResult.content)
  return parts.join('\n')
}

/**
 * 会话内搜索：大小写不敏感子串匹配，按时间顺序返回命中（正文/工具名/参数/输出）。
 * query 为空或仅空白时返回空数组。
 */
export function searchAgentMessages(messages: AgentMessage[], query: string): MessageSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: MessageSearchHit[] = []
  messages.forEach((m, index) => {
    if (searchableText(m).toLowerCase().includes(q)) {
      hits.push({ index, id: m.id, role: m.role })
    }
  })
  return hits
}

// ---------- 附件读取 ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log', '.ini', '.conf', '.toml']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_SIZE = 2 * 1024 * 1024
/** 单条消息最多附带的附件数（与原实现保持一致） */
export const MAX_ATTACHMENTS = 8
/** 文件选择框 accept 列表（与 Chat Composer 对齐） */
export const ATTACHMENT_ACCEPT = 'image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log,.ini,.conf,.toml'

export async function readFileAsAttachment(file: File): Promise<ChatAttachment | null> {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()
  const isImage = IMAGE_TYPES.includes(file.type) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
  const isText = TEXT_TYPES.includes(file.type) || TEXT_EXTS.includes(ext)
  return new Promise((resolve) => {
    if (isImage) {
      if (file.size > MAX_IMAGE_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'image', name: file.name, mimeType: file.type || 'image/png', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsDataURL(file)
    } else if (isText) {
      if (file.size > MAX_TEXT_SIZE) { resolve(null); return }
      const r = new FileReader()
      r.onload = () => resolve({ type: 'text', name: file.name, mimeType: file.type || 'text/plain', size: file.size, data: r.result as string })
      r.onerror = () => resolve(null)
      r.readAsText(file)
    } else { resolve(null) }
  })
}

/** 运行耗时人类可读：<1s 显示毫秒，否则秒（保留 1 位小数） */
export function formatRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 提取消息文本中第一个 ```html 代码块（供「在沙箱运行」按钮使用） */
export function extractFirstHtmlBlock(text: string): string | null {
  const m = text.match(/```html\s*\r?\n([\s\S]*?)```/i)
  return m ? m[1] ?? null : null
}

/** DB MessageRecord[] → Agent 对话视图的 AgentMessage[]（tool 消息拆 call/result 两张卡） */
export function toAgentMessages(dbMsgs: MessageRecord[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of dbMsgs) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', text: m.content, attachments: m.attachments, dbId: m.id })
    } else if (m.role === 'assistant') {
      // 历史加载：streaming 残留（中断/出错未清理）视为终止，避免永远显示「思考中…」
      out.push({
        id: m.id,
        role: 'assistant',
        text: m.content || (m.status === 'streaming' ? '（中断）' : ''),
        isFinal: true,
        sources: m.sources ?? undefined,
        dbId: m.id
      })
    } else if (m.role === 'tool') {
      try {
        const tr = JSON.parse(m.content) as ToolResult
        // 若有调用参数，先显示 tool_call 步骤，再显示 tool_result
        if (tr.arguments) {
          out.push({
            id: `${m.id}-call`,
            role: 'tool',
            text: '',
            toolCall: {
              id: tr.toolCallId,
              type: 'function',
              function: { name: tr.name, arguments: tr.arguments }
            },
            dbId: m.id
          })
        }
        out.push({
          id: m.id,
          role: 'tool',
          text: tr.content,
          toolResult: tr,
          isError: tr.isError,
          dbId: m.id
        })
      } catch {
        out.push({ id: m.id, role: 'tool', text: m.content, dbId: m.id })
      }
    }
  }
  return out
}

