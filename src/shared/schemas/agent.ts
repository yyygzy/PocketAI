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
