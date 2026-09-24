// Agent 模块共享：类型、常量与纯函数（MCP 面板 / Agent 对话 / Channels 共用）
import type { ChatAttachment, MessageRecord, TodoItem, ToolCall, ToolResult } from '../../../../shared/types'

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
}

// ---------- 附件读取 ----------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']
const TEXT_TYPES = ['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/html', 'application/xml', 'text/x-python', 'text/javascript']
const TEXT_EXTS = ['.txt', '.md', '.json', '.csv', '.html', '.xml', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.sh', '.sql', '.log']
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_SIZE = 2 * 1024 * 1024
/** 单条消息最多附带的附件数（与原实现保持一致） */
export const MAX_ATTACHMENTS = 8
/** 文件选择框 accept 列表 */
export const ATTACHMENT_ACCEPT = 'image/*,.txt,.md,.json,.csv,.html,.xml,.py,.js,.ts,.tsx,.jsx,.yaml,.yml,.sh,.sql,.log'

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
      out.push({ id: m.id, role: 'user', text: m.content, attachments: m.attachments })
    } else if (m.role === 'assistant') {
      // 历史加载：streaming 残留（中断/出错未清理）视为终止，避免永远显示「思考中…」
      out.push({
        id: m.id,
        role: 'assistant',
        text: m.content || (m.status === 'streaming' ? '（中断）' : ''),
        isFinal: true
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
            }
          })
        }
        out.push({
          id: m.id,
          role: 'tool',
          text: tr.content,
          toolResult: tr,
          isError: tr.isError
        })
      } catch {
        out.push({ id: m.id, role: 'tool', text: m.content })
      }
    }
  }
  return out
}
