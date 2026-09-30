// 对话导出：Markdown 构建（纯函数，主进程 IPC 与渲染端批量导出共用）
//
// 与旧版（handler 内 escapeMdCodeBlock 全包代码块）的区别：
// - assistant 正文保真输出（标题/列表/表格/代码块原样保留）
// - user 正文以引用块逐行包裹（区分角色 + 防内容伪造文档结构）
// - 追加 RAG 参考来源、附件、token 用量信息
import type {
  ChatAttachment,
  KbAskMessage,
  MessageRecord,
  MessageSource,
  UsageStats
} from './types'

/** 文本附件预览截断长度（防超大附件撑爆导出文件） */
const TEXT_ATTACH_PREVIEW_LIMIT = 2000

/** 导出会话所需的会话元信息（MessageRecord 之外的部分） */
export interface ExportConversationMeta {
  title: string
  modelLabel: string | null
  createdAt: number
  updatedAt: number
  assistantId?: string | null
}

/** 文件名安全化：Windows 非法字符替换为 _，去除首尾空格/点；全为非法字符时兜底 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|\.+$/g, '').trim()
  // 替换后只剩下划线（如 '///' → '___'）同样视为无有效文件名
  return cleaned === '' || /^_+$/.test(cleaned) ? 'conversation' : cleaned
}

/**
 * 批量导出文件名去重：同名自动追加 -2/-3…（保持扩展名分离）。
 * 输入输出顺序一一对应。
 */
export function dedupeFileNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count === 0) return name
    const dot = name.lastIndexOf('.')
    const base = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    // 继续找不冲突序号（极端情况下 -2 也撞）
    let candidate = `${base}-${count + 1}${ext}`
    let n = count + 1
    while (seen.has(candidate)) {
      n += 1
      candidate = `${base}-${n}${ext}`
    }
    seen.set(candidate, 1)
    return candidate
  })
}

/** 来源去重（按文档标题）→ 有序列表条目文本 */
export function formatSources(sources: MessageSource[] | null | undefined): string[] {
  if (!sources || sources.length === 0) return []
  const titles: string[] = []
  for (const s of sources) {
    const title = s.docTitle?.trim() || '(未命名文档)'
    if (!titles.includes(title)) titles.push(title)
  }
  return titles.map((title, i) => `[${i + 1}] ${title}`)
}

/** 附件 → Markdown 行：图片只列名（base64 不入文件），文本附截断预览 */
export function formatAttachments(attachments: ChatAttachment[] | null | undefined): string[] {
  if (!attachments || attachments.length === 0) return []
  const lines: string[] = []
  for (const att of attachments) {
    if (att.type === 'image') {
      lines.push(`📎 图片：${att.name}`)
    } else {
      const preview = att.data && att.data.length > TEXT_ATTACH_PREVIEW_LIMIT
        ? att.data.slice(0, TEXT_ATTACH_PREVIEW_LIMIT) + '\n…（截断）'
        : att.data ?? ''
      lines.push(`📎 文本附件：${att.name}`)
      if (preview.trim()) {
        for (const ln of preview.replace(/\s+$/, '').split('\n')) lines.push(`> ${ln}`)
      }
    }
  }
  return lines
}

/** 消息角色 → 导出文档中的中文标签（Markdown/HTML 共用） */
export function roleLabel(role: string): string {
  switch (role) {
    case 'user': return '👤 用户'
    case 'assistant': return '🤖 助手'
    case 'system': return '⚙️ 系统'
    case 'tool': return '🔧 工具'
    default: return role
  }
}

function formatToolCalls(raw: string): string[] {
  const lines: string[] = ['**Tool Calls**：']
  try {
    const calls = JSON.parse(raw)
    if (Array.isArray(calls) && calls.length > 0) {
      for (const c of calls) {
        const name = c.function?.name ?? c.name ?? 'unknown'
        const args = c.function?.arguments ?? JSON.stringify(c, null, 2)
        lines.push(`- \`${name}\` → ${String(args).replace(/\s+$/, '')}`)
      }
      return lines
    }
  } catch { /* 非 JSON 走原文 */ }
  lines.push('```', String(raw).replace(/\s+$/, ''), '```')
  return lines
}

function usageLine(usage: UsageStats | null | undefined): string | null {
  if (!usage) return null
  return `*tokens：输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 合计 ${usage.totalTokens}*`
}

/** 把多行文本逐行包成引用块（空行用 > 保持引用连续） */
function quoteBlock(text: string): string {
  return text.replace(/\s+$/, '').split('\n').map((ln) => `> ${ln}`).join('\n')
}

/**
 * 构建单个会话的 Markdown 导出文本。
 * @param assistantName 助手名称（由调用方查询后注入，纯函数不依赖 repo）
 */
export function buildConversationMarkdown(
  conv: ExportConversationMeta,
  messages: MessageRecord[],
  assistantName?: string | null
): string {
  const dateFmt = (ts: number) => new Date(ts).toLocaleString()

  const lines: string[] = []
  lines.push(`# ${conv.title}`, '')
  lines.push(`> **模型**：\`${conv.modelLabel ?? '未知'}\``)
  if (assistantName) lines.push(`> **助手**：${assistantName}`)
  lines.push(`> **创建时间**：${dateFmt(conv.createdAt)}`)
  lines.push(`> **最后更新**：${dateFmt(conv.updatedAt)}`)
  lines.push(`> **消息数**：${messages.length}`)
  lines.push('', '---', '')

  for (const msg of messages) {
    lines.push(`## ${roleLabel(msg.role)} — ${dateFmt(msg.createdAt)}`, '')

    const attLines = formatAttachments(msg.attachments)
    if (attLines.length > 0) lines.push(...attLines, '')

    if (msg.toolCalls) lines.push(...formatToolCalls(msg.toolCalls), '')

    if (msg.content) {
      if (msg.role === 'user') {
        // 用户内容引用块包裹：视觉区分 + 防内容伪造文档标题/分隔结构
        lines.push(quoteBlock(msg.content), '')
      } else {
        // assistant/system/tool 正文保真（保留 AI 回复的 Markdown 排版）
        lines.push(msg.content.replace(/\s+$/, ''), '')
      }
    }

    const srcLines = formatSources(msg.sources)
    if (srcLines.length > 0) {
      lines.push('**参考来源：**', ...srcLines.map((s) => `- ${s}`), '')
    }

    const usage = usageLine(msg.usage)
    if (usage) lines.push(usage, '')

    lines.push('---', '')
  }

  return lines.join('\n')
}

/** KB 问答会话导出所需的会话元信息（KbAskMessage 之外的部分） */
export interface ExportKbAskSessionMeta {
  title: string
  model: string
  createdAt: number
  updatedAt: number
}

/**
 * 构建 KB 问答会话 Markdown（纯函数，主进程 IPC 与测试共用）。
 * 比 buildConversationMarkdown 更简：KbAskMessage 无 attachments/toolCalls/usage/createdAt，
 * 仅 role/content/sources；每条消息不单独标时间（问答时序由消息顺序体现）。
 */
export function buildKbAskSessionMarkdown(
  session: ExportKbAskSessionMeta,
  messages: KbAskMessage[]
): string {
  const dateFmt = (ts: number) => new Date(ts).toLocaleString()

  const lines: string[] = []
  lines.push(`# ${session.title}`, '')
  lines.push(`> **模型**：\`${session.model || '未知'}\``)
  lines.push(`> **创建时间**：${dateFmt(session.createdAt)}`)
  lines.push(`> **最后更新**：${dateFmt(session.updatedAt)}`)
  lines.push(`> **消息数**：${messages.length}`)
  lines.push('', '---', '')

  for (const msg of messages) {
    lines.push(`## ${roleLabel(msg.role)}`, '')
    if (msg.content) {
      if (msg.role === 'user') {
        lines.push(quoteBlock(msg.content), '')
      } else {
        lines.push(msg.content.replace(/\s+$/, ''), '')
      }
    }
    const srcLines = formatSources(msg.sources)
    if (srcLines.length > 0) {
      lines.push('**参考来源：**', ...srcLines.map((s) => `- ${s}`), '')
    }
    lines.push('---', '')
  }

  return lines.join('\n')
}
