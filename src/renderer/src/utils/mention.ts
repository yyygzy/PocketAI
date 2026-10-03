// @ 触发 mention（知识库/文件引用）的纯函数
import type { ChatAttachment, KnowledgeBase, MessageRecord } from '../../../shared/types'

export interface MentionTriggerInfo {
  query: string
  startPos: number
}

/**
 * 识别输入框末尾是否处于 @ 触发态。
 * 规则：仅在行首或空白字符后触发，避免邮箱/路径误命中。
 * 取光标前最后一个 @，要求前一字符是行首/空格/换行。
 */
export function getMentionQuery(input: string, cursor = input.length): MentionTriggerInfo | null {
  const prefix = input.slice(0, cursor)
  for (let i = prefix.length - 1; i >= 0; i--) {
    const ch = prefix[i]
    if (ch === '@') {
      const prev = prefix[i - 1]
      if (i === 0 || /\s/.test(prev ?? '')) {
        return { query: prefix.slice(i + 1), startPos: i }
      }
      return null
    }
    if (ch === undefined || /\s/.test(ch)) break
  }
  return null
}

/** 按名称过滤知识库（不区分大小写） */
export function filterMentionKbs(kbs: KnowledgeBase[], query: string): KnowledgeBase[] {
  const q = query.trim().toLowerCase()
  if (!q) return kbs
  return kbs.filter(
    (kb) => kb.name.toLowerCase().includes(q) || (kb.description ?? '').toLowerCase().includes(q)
  )
}

/** 从会话消息中提取最近附件（去重，按消息时间倒序），按名称过滤 */
export function filterMentionFiles(messages: MessageRecord[], query: string): ChatAttachment[] {
  const seen = new Set<string>()
  const out: ChatAttachment[] = []
  // 从最新消息往前找
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m?.attachments) continue
    for (const att of m.attachments) {
      if (seen.has(att.name)) continue
      seen.add(att.name)
      const q = query.trim().toLowerCase()
      if (!q || att.name.toLowerCase().includes(q)) {
        out.push(att)
      }
    }
  }
  return out
}
