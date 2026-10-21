// Work Agent IPC 入参 schema
// apiKey 落库、paths 是本地 .ics 文件读取面，带宽松资源上限。
import { z } from 'zod'
import { CHAT_MAX_CONTENT_CHARS } from './chat'

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

/** AGENT_PROBE_DELEGATE_CAP 入参：模型名上限与文本协议开关同一档（128） */
export const delegateProbeSchema = z.object({
  providerId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  model: z.string().min(1).max(128)
})

/** AGENT_SET_DELEGATE_ENABLED 入参（决策③：默认关，用户点名某台模型才允许顺序委派） */
export const delegateToggleSchema = z.object({
  providerId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  model: z.string().min(1).max(128),
  on: z.boolean()
})

/**
 * AGENT_INTERJECT 入参（V4-Iter-238）：运行中插队的一句话。
 * `clientRef` 是渲染层给排队项的本地 id（引擎原样回进 step 事件，界面据此知道哪条已被收下）；
 * 与 requestId 同长度档。文本上限与 CHAT_SEND 的 content 同一档——它落的是同一张 messages 表，
 * 另立一个数就会出现「正常发送能过、插队被拒」。
 * 只有空白不算内容：引擎会原样落库并进上下文，空串只会让模型多一条没有信息量的 user 消息。
 */
export const interjectSchema = z.object({
  requestId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  clientRef: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  text: z
    .string()
    .max(CHAT_MAX_CONTENT_CHARS, `插队内容过长（上限 ${CHAT_MAX_CONTENT_CHARS} 字符）`)
    .refine((s) => s.trim().length > 0, '插队内容不能为空')
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

/**
 * AGENT_SET_MODEL_WINDOW 入参（V4-Iter-234）：设/清一台模型的上下文窗口。
 * `tokens: null` 表示清除（回到"未设"），所以这不是普通 toggle，值域校验留给服务层
 * （整数、512–4,000,000）；这里只挡类型与 id 形状。服务层拒绝时**只回码**，
 * 句子由界面按语言拼（口径同 §152 的委派开关）。
 */
export const modelWindowSetSchema = z.object({
  providerId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  model: z.string().min(1).max(128),
  tokens: z.number().int().nullable()
})
