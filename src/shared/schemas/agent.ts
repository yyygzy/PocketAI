// Work Agent IPC 入参 schema
// apiKey 落库、paths 是本地 .ics 文件读取面，带宽松资源上限。
import { z } from 'zod'

const AGENT_MAX_APIKEY_CHARS = 256
const AGENT_MAX_PATH_CHARS = 1024
const AGENT_MAX_PATHS = 20
const AGENT_MAX_ID_CHARS = 64

/** AGENT_SET_SHELL_CONFIG 入参 */
export const shellConfigSchema = z.object({
  enabled: z.boolean().optional(),
  policy: z.enum(['confirm', 'auto-safe']).optional()
})

/** AGENT_SET_WEBSEARCH_CONFIG 入参（错误消息与 websearch-config 服务层文案一致） */
export const websearchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['tavily', 'bocha']).optional(),
  apiKey: z
    .string()
    .max(AGENT_MAX_APIKEY_CHARS, 'API Key 过长（上限 256 字符），请检查后重试')
    .optional()
})

/** AGENT_SET_CALENDAR_CONFIG 入参 */
export const calendarConfigSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string().max(AGENT_MAX_PATH_CHARS)).max(AGENT_MAX_PATHS).optional()
})

/** AGENT_TOOL_APPROVE_RESPONSE 入参 */
export const toolApproveResponseSchema = z.object({
  approvalId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  approved: z.boolean(),
  alwaysAllow: z.boolean().optional()
})

/**
 * AGENT_SET_TEXT_PROTOCOL 入参：点名某台模型走/不走文本协议（§4.4-⑦ 显式开关）。
 * model 名与 providerId 同长度档：都远小于上限，超限只可能是脏输入或攻击面探测。
 */
export const textProtocolToggleSchema = z.object({
  providerId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  // 模型名不受 id 上限约束（带 registry/量化后缀的长名实测可超 64），单列一档 128
  model: z.string().min(1).max(128),
  on: z.boolean()
})
