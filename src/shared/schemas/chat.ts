// 聊天模块 IPC 入参 schema
// 消息体是用户可控输入，校验类型与必填字段，防止畸形 payload 进入
// 对话服务（避免 undefined 字段触发运行时异常或注入）。
import { z } from 'zod'

const chatTargetSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1)
})

const chatAttachmentSchema = z.object({
  type: z.enum(['image', 'text']),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  data: z.string()
})

/** CHAT_SEND 入参 */
export const sendMessagePayloadSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  assistantId: z.string().nullable(),
  content: z.string(),
  targets: z.array(chatTargetSchema).min(1, '至少需要一个目标模型'),
  agentMode: z.boolean().optional(),
  attachments: z.array(chatAttachmentSchema).optional(),
  unattended: z.boolean().optional()
})

/** CHAT_REGENERATE 入参 */
export const regeneratePayloadSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  assistantId: z.string().nullable(),
  messageId: z.string().min(1),
  targets: z.array(chatTargetSchema).min(1)
})

/** CHAT_RESEND 入参 */
export const resendPayloadSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  assistantId: z.string().nullable(),
  messageId: z.string().min(1),
  content: z.string().optional(),
  targets: z.array(chatTargetSchema).min(1)
})

/** 请求 ID（CHAT_ABORT） */
export const requestIdSchema = z.string().min(1)
