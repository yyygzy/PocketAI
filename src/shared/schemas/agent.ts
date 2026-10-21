// Work Agent IPC 入参 schema
// apiKey 落库、paths 是本地 .ics 文件读取面，带宽松资源上限。
import { z } from 'zod'
import { CHAT_MAX_CONTENT_CHARS } from './chat'
import { FALLBACK_MAX_PART_CHARS } from '../fallback-target'
import { AGENT_EVAL_MAX_K } from '../agent-eval'

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
 * AGENT_SET_FALLBACK 入参（V4-Iter-237）：设／清某台模型的备用 target。
 * `target: null` 表示清除（回到"没备用"），判据同 §234 那颗窗口：类型与形状在这儿挡，
 * "指向自己"这类语义拒绝留在服务层（它才知道现有表里是谁）。id 长度与 `FALLBACK_MAX_PART_CHARS` 同档。
 */
const fallbackPartSchema = z
  .string()
  .min(1)
  .max(FALLBACK_MAX_PART_CHARS, `标识过长（上限 ${FALLBACK_MAX_PART_CHARS} 字符）`)

export const fallbackSetSchema = z.object({
  providerId: fallbackPartSchema,
  model: fallbackPartSchema,
  target: z
    .object({ providerId: fallbackPartSchema, model: fallbackPartSchema })
    .nullable()
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

/**
 * AGENT_EVAL_RUN 入参（V4-Iter-242）：跑一趟评测集。
 * `k` 的上限不是随手拍的：Agent 一发是十几秒到几十秒、还直接花额度，
 * 所以卡在 `AGENT_EVAL_MAX_K`（检索评测那个 50 在这儿完全不适用）。
 * 档位只认 `smoke`/`full` 两个字面值——写成别的（包括"all"）都在这儿挡掉，
 * 因为服务层是 `tier === 'full' ? 全量 : 冒烟`，一个宽松的字符串会被静默读成冒烟。
 */
export const evalRunSchema = z.object({
  providerId: z.string().min(1).max(AGENT_MAX_ID_CHARS),
  model: z.string().min(1).max(128),
  tier: z.enum(['smoke', 'full']).optional(),
  k: z.number().int().min(1).max(AGENT_EVAL_MAX_K).optional()
})

/**
 * AGENT_EVAL_READ_REPORT 入参：只接受清单里那种**裸文件名**（形状闸在这儿，
 * "是不是真有其文件"留在服务层）。斜杠／反斜杠／`..` 一律挡：这是评测目录的读面，不是任意文件读面。
 */
export const evalReportNameSchema = z
  .string()
  .min(4)
  .max(128)
  .regex(/^[^/\\]+\.md$/, '报告名只能是一个 .md 文件名')
