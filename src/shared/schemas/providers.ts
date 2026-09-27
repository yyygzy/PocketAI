// Provider 配置 IPC 入参 schema
// Provider 保存直接落库，需校验类型与必填字段，防止畸形配置
// 进入 provider manager（影响 API 调用 / 模型拉取）。
// baseUrl 是出网目标（safeFetch 收口 SSRF），此处只限长度不限协议
//（内网代理/自定义网关是合法场景）。
import { z } from 'zod'

const PROVIDER_MAX_NAME_CHARS = 100
const PROVIDER_MAX_BASEURL_CHARS = 2048
const PROVIDER_MAX_APIKEY_CHARS = 256
const PROVIDER_MAX_APIKEYS = 50
const PROVIDER_MAX_MODEL_CHARS = 200
const PROVIDER_MAX_MODELS = 500
const PROVIDER_MAX_ID_CHARS = 64

const providerTypeSchema = z.enum(['openai-compatible', 'ollama', 'gemini', 'anthropic'])

/** PROVIDER_SAVE 入参：完整 ProviderRecord */
export const providerRecordSchema = z.object({
  id: z.string().min(1).max(PROVIDER_MAX_ID_CHARS),
  type: providerTypeSchema,
  name: z.string().min(1).max(PROVIDER_MAX_NAME_CHARS),
  baseUrl: z.string().max(PROVIDER_MAX_BASEURL_CHARS),
  apiKeys: z.array(z.string().max(PROVIDER_MAX_APIKEY_CHARS)).max(PROVIDER_MAX_APIKEYS),
  models: z.array(z.string().max(PROVIDER_MAX_MODEL_CHARS)).max(PROVIDER_MAX_MODELS),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** 通用 ID 入参（PROVIDER_DELETE / FETCH_MODELS / TEST，亦被 knowledge/notes 等 handler 复用） */
export const idSchema = z.string().min(1).max(128)
