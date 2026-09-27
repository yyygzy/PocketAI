// 聊天模块 IPC 入参 schema
// 消息体是用户可控输入（渲染层被攻破时即不可信），校验类型、必填字段与资源上限，
// 防止畸形/巨型 payload 进入对话服务：content 与附件 data 会原样进 LLM 请求体并落库，
// 无界 payload 可造成主进程内存尖峰、DB 膨胀与巨额 token 消耗。
import { z } from 'zod'

// ─── 资源上限（取值宽松，正常使用不可达） ────────────────────────
/** 单条消息文本字符上限（与 conversations 导入单条 content 上限对齐，约 50 万汉字） */
export const CHAT_MAX_CONTENT_CHARS = 1_000_000
/** 一次发送的目标模型数上限（多模型并行） */
export const CHAT_MAX_TARGETS = 10
/** 单条消息附件数量上限 */
export const CHAT_MAX_ATTACHMENTS = 10
/** 单个附件 data（文本全文或图片 data URL）字符上限，约 15MB 二进制 */
export const CHAT_MAX_ATTACHMENT_DATA_CHARS = 20_000_000
/** 单条消息全部附件 data 总字符上限（约 30MB，覆盖多张截图场景） */
export const CHAT_MAX_ATTACHMENT_TOTAL_CHARS = 30_000_000
/** 附件文件名/元数据字段长度 */
const CHAT_MAX_ATTACHMENT_NAME_CHARS = 255
const CHAT_MAX_MIME_CHARS = 100
/** provider/model 标识长度（配置名，留足余量） */
const CHAT_MAX_TARGET_LABEL_CHARS = 200
/** 各类运行时 ID（UUID 形态，历史上界 64） */
const CHAT_MAX_ID_CHARS = 64

const chatId = z.string().min(1).max(CHAT_MAX_ID_CHARS)

const chatTargetSchema = z.object({
  providerId: z.string().min(1).max(CHAT_MAX_TARGET_LABEL_CHARS),
  model: z.string().min(1).max(CHAT_MAX_TARGET_LABEL_CHARS)
})

const chatAttachmentSchema = z.object({
  type: z.enum(['image', 'text']),
  name: z.string().max(CHAT_MAX_ATTACHMENT_NAME_CHARS),
  mimeType: z.string().max(CHAT_MAX_MIME_CHARS),
  size: z.number().int().nonnegative().max(CHAT_MAX_ATTACHMENT_DATA_CHARS),
  data: z.string().max(CHAT_MAX_ATTACHMENT_DATA_CHARS)
})

/** 附件公共收口：数量与 data 总量双重上限 */
const attachmentsField = z
  .array(chatAttachmentSchema)
  .max(CHAT_MAX_ATTACHMENTS)
  .superRefine((atts, ctx) => {
    let total = 0
    for (let i = 0; i < atts.length; i++) {
      total += atts[i]?.data?.length ?? 0
      if (total > CHAT_MAX_ATTACHMENT_TOTAL_CHARS) {
        ctx.addIssue({
          code: 'custom',
          message: `附件总大小超过 ${Math.floor(CHAT_MAX_ATTACHMENT_TOTAL_CHARS / 1_000_000)}MB 上限`
        })
        return
      }
    }
  })

/** CHAT_SEND 入参 */
export const sendMessagePayloadSchema = z.object({
  requestId: chatId,
  conversationId: chatId,
  assistantId: z.string().max(CHAT_MAX_ID_CHARS).nullable(),
  content: z.string().max(CHAT_MAX_CONTENT_CHARS),
  targets: z.array(chatTargetSchema).min(1, '至少需要一个目标模型').max(CHAT_MAX_TARGETS),
  agentMode: z.boolean().optional(),
  attachments: attachmentsField.optional(),
  unattended: z.boolean().optional()
})

/** CHAT_REGENERATE 入参 */
export const regeneratePayloadSchema = z.object({
  requestId: chatId,
  conversationId: chatId,
  assistantId: z.string().max(CHAT_MAX_ID_CHARS).nullable(),
  messageId: chatId,
  targets: z.array(chatTargetSchema).min(1).max(CHAT_MAX_TARGETS)
})

/** CHAT_RESEND 入参 */
export const resendPayloadSchema = z.object({
  requestId: chatId,
  conversationId: chatId,
  assistantId: z.string().max(CHAT_MAX_ID_CHARS).nullable(),
  messageId: chatId,
  content: z.string().max(CHAT_MAX_CONTENT_CHARS).optional(),
  targets: z.array(chatTargetSchema).min(1).max(CHAT_MAX_TARGETS)
})

/** 请求 ID（CHAT_ABORT） */
export const requestIdSchema = chatId
