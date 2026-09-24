// 聊天上下文附件处理（收口层）
//
// ChatService（普通对话）与 AgentEngine（ReAct 循环）构建 LLM 上下文时，
// 对「user 消息携带的文本/图片附件」做同样的还原与注入：
//   - 文本附件 → 追加到消息文本（--- name --- 分隔区块）
//   - 图片附件 → 构建 multimodal content parts（text + image_url）
// 统一收口到本模块，避免两处内联实现漂移。
import type { AdapterChatMessage, MessageContentPart } from '../providers/types'
import type { ChatAttachment } from '../../shared/types'

/** 将文本附件拼接为「--- name ---」分隔区块，追加到消息文本末尾 */
export function appendTextAttachments(text: string, textAtts: ChatAttachment[]): string {
  let out = text
  for (const ta of textAtts) {
    out += `\n\n--- ${ta.name} ---\n${ta.data}`
  }
  return out
}

/** 图片附件构建 multimodal content parts（text 在前 + image_url 数组） */
export function buildImageParts(text: string, imageAtts: ChatAttachment[]): MessageContentPart[] {
  return [
    { type: 'text', text },
    ...imageAtts.map((a) => ({ type: 'image_url' as const, image_url: { url: a.data } }))
  ]
}

/** 将附件注入到上下文最后一条 user 消息（构建 multimodal 格式） */
export function injectAttachments(messages: AdapterChatMessage[], attachments?: ChatAttachment[]): void {
  if (!attachments || attachments.length === 0) return
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user') {
      const textContent = typeof m.content === 'string' ? m.content as string : ''
      const textAttachments = attachments.filter(a => a.type === 'text')
      const imageAttachments = attachments.filter(a => a.type === 'image')

      const text = appendTextAttachments(textContent, textAttachments)

      if (imageAttachments.length > 0) {
        m.content = buildImageParts(text, imageAttachments)
      } else {
        m.content = text
      }
      break
    }
  }
}
