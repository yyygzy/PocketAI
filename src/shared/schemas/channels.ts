// IM 渠道 IPC 入参 schema
// token/secret 落加密存储，whitelist 是用户 id 列表文本，带宽松上限。
import { z } from 'zod'

const CHANNEL_MAX_SECRET_CHARS = 512
const CHANNEL_MAX_WHITELIST_CHARS = 2000
const CHANNEL_MAX_ID_CHARS = 200

const channelTypeSchema = z.enum(['telegram', 'discord', 'slack', 'feishu', 'dingtalk'])

/** CHANNEL_SET_CONFIG 第二参：字段全部 optional，按白名单校验。
 *  错误消息与 channel-config 服务层既有文案保持一致（服务层在 trim 后复核）。 */
export const channelSetConfigSchema = z.object({
  enabled: z.boolean().optional(),
  primarySecret: z
    .string()
    .max(CHANNEL_MAX_SECRET_CHARS, '主凭据过长（上限 512 字符），请检查后重试')
    .optional(),
  secondarySecret: z
    .string()
    .max(CHANNEL_MAX_SECRET_CHARS, '次凭据过长（上限 512 字符），请检查后重试')
    .optional(),
  appId: z.string().max(CHANNEL_MAX_ID_CHARS).optional(),
  whitelist: z.string().max(CHANNEL_MAX_WHITELIST_CHARS).optional(),
  assistantId: z.string().max(CHANNEL_MAX_ID_CHARS).optional(),
  providerId: z.string().max(CHANNEL_MAX_ID_CHARS).optional(),
  model: z.string().max(CHANNEL_MAX_ID_CHARS).optional(),
  agentMode: z.boolean().optional()
})

/** CHANNEL_GET_CONFIG / START / STOP 第一参 */
export const channelTypeArgSchema = channelTypeSchema
