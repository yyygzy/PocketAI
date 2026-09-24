// Provider 配置 IPC 入参 schema
// Provider 保存直接落库，需校验类型与必填字段，防止畸形配置
// 进入 provider manager（影响 API 调用 / 模型拉取）。
import { z } from 'zod'

const providerTypeSchema = z.enum(['openai-compatible', 'ollama', 'gemini', 'anthropic'])

/** PROVIDER_SAVE 入参：完整 ProviderRecord */
export const providerRecordSchema = z.object({
  id: z.string().min(1),
  type: providerTypeSchema,
  name: z.string().min(1),
  baseUrl: z.string(),
  apiKeys: z.array(z.string()),
  models: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** 通用 ID 入参（PROVIDER_DELETE / FETCH_MODELS / TEST） */
export const idSchema = z.string().min(1)
