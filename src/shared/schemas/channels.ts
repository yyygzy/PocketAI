// IM 渠道 IPC 入参 schema
import { z } from 'zod'

const channelTypeSchema = z.enum(['telegram', 'discord', 'slack', 'feishu', 'dingtalk'])

/** CHANNEL_SET_CONFIG 第二参：字段全部 optional，按白名单校验 */
export const channelSetConfigSchema = z.object({
  enabled: z.boolean().optional(),
  primarySecret: z.string().optional(),
  secondarySecret: z.string().optional(),
  appId: z.string().optional(),
  whitelist: z.string().optional(),
  assistantId: z.string().optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  agentMode: z.boolean().optional()
})

/** CHANNEL_GET_CONFIG / START / STOP 第一参 */
export const channelTypeArgSchema = channelTypeSchema
