// Work Agent IPC 入参 schema
import { z } from 'zod'

/** AGENT_SET_SHELL_CONFIG 入参 */
export const shellConfigSchema = z.object({
  enabled: z.boolean().optional(),
  policy: z.enum(['confirm', 'auto-safe']).optional()
})

/** AGENT_SET_WEBSEARCH_CONFIG 入参 */
export const websearchConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['tavily', 'bocha']).optional(),
  apiKey: z.string().optional()
})

/** AGENT_SET_CALENDAR_CONFIG 入参 */
export const calendarConfigSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string()).optional()
})

/** AGENT_TOOL_APPROVE_RESPONSE 入参 */
export const toolApproveResponseSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
  alwaysAllow: z.boolean().optional()
})
