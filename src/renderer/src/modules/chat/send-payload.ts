import type { ChatAttachment, ChatTarget, SendMessagePayload } from '../../../../shared/types'

/**
 * 组装 chat:send 载荷（P0-4 v1）。
 *
 * `agentMode` 只在实际开启时写入：关闭／普通模式连字段都不发，
 * 让后端 `payload.agentMode` 的真假分支保持单一事实来源（`chat-service.ts` 只认 true）。
 */
export function buildChatSendPayload(args: {
  requestId: string
  conversationId: string
  assistantId: string | null
  content: string
  targets: ChatTarget[]
  agentMode: boolean
  attachments?: ChatAttachment[]
  replyToId?: string | null
  kbRefs?: string[]
}): SendMessagePayload {
  return {
    requestId: args.requestId,
    conversationId: args.conversationId,
    assistantId: args.assistantId,
    content: args.content,
    targets: args.targets,
    ...(args.agentMode ? { agentMode: true } : {}),
    attachments: args.attachments,
    replyToId: args.replyToId ?? null,
    kbRefs: args.kbRefs
  }
}
