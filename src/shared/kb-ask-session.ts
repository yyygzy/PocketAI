// KB 问答会话纯函数：标题生成与消息体容错解析。
// 零依赖（不 import electron/db），供主进程 repo 与 tests/ 双侧复用。
import type { KbAskMessage, MessageSource } from './types'

/** 会话标题最大长度（首问截断，超出加省略号） */
export const KB_ASK_TITLE_MAX = 40

/** 用首问生成会话标题：去首尾空白，超长截断加省略号；空问返回空串 */
export function sessionTitleFrom(question: string): string {
  const q = question.trim()
  if (!q) return ''
  if (q.length <= KB_ASK_TITLE_MAX) return q
  return q.slice(0, KB_ASK_TITLE_MAX) + '…'
}

function isValidSource(s: unknown): s is MessageSource {
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof (s as MessageSource).chunkId === 'string' &&
    typeof (s as MessageSource).docId === 'string' &&
    typeof (s as MessageSource).docTitle === 'string' &&
    typeof (s as MessageSource).content === 'string'
  )
}

function isValidMessage(m: unknown): m is KbAskMessage {
  if (typeof m !== 'object' || m === null) return false
  const msg = m as KbAskMessage
  if ((msg.role !== 'user' && msg.role !== 'assistant') || typeof msg.content !== 'string') {
    return false
  }
  if (msg.sources !== undefined) {
    if (!Array.isArray(msg.sources) || !msg.sources.every(isValidSource)) return false
  }
  return true
}

/**
 * 容错解析落库的消息体 JSON：
 * 非法 JSON / 非数组返回 []，过滤 role/content/sources 不合法的项。
 */
export function parseKbAskMessages(json: string): KbAskMessage[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isValidMessage)
}
