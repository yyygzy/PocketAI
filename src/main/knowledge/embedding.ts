// Embedding 服务：批量向量化，调用用户配置的 Provider 的 embedding API
// v1 走 OpenAI 兼容 /v1/embeddings；providerId 为 builtin 时走内置本地模型
import { providerManager } from '../providers/manager'
import { BUILTIN_EMBED_PROVIDER_ID, BUILTIN_QUERY_PREFIX } from '../../shared/types'
import { localEmbedTexts, localEmbedQuery } from './local-embedding'

const BATCH_SIZE = 32 // 单次请求最大文本数，避免 payload 过大

/** 批量向量化：把文本数组按批次请求，返回与输入等长的 Float32Array 数组 */
export async function embedTexts(
  providerId: string,
  model: string,
  texts: string[]
): Promise<Float32Array[]> {
  if (texts.length === 0) return []

  // 内置本地模型：整批交给本地引擎（内部自动分桶，无远程 payload 限制）
  if (providerId === BUILTIN_EMBED_PROVIDER_ID) {
    const result: Float32Array[] = []
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      result.push(...(await localEmbedTexts(texts.slice(i, i + BATCH_SIZE))))
    }
    return result
  }

  const adapter = providerManager.getAdapter(providerId)
  const result: Float32Array[] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const vectors = await adapter.embed(batch, model)
    if (vectors.length !== batch.length) {
      throw new Error(
        `向量化返回数量不匹配：期望 ${batch.length}，实际 ${vectors.length}`
      )
    }
    for (const v of vectors) {
      result.push(Float32Array.from(v))
    }
  }
  return result
}

/** 单条向量化（用于检索查询） */
export async function embedQuery(
  providerId: string,
  model: string,
  query: string
): Promise<Float32Array> {
  // 内置本地模型：查询侧自动加 bge 检索指令前缀（幂等）
  if (providerId === BUILTIN_EMBED_PROVIDER_ID) {
    return localEmbedQuery(query)
  }

  const adapter = providerManager.getAdapter(providerId)
  const [vec] = await adapter.embed([query], model)
  if (!vec) throw new Error('embedding 适配器返回空结果')
  return Float32Array.from(vec)
}

/** 查询侧是否需要补 bge 指令前缀（暴露给 KB 检索测试 UI 展示/单测用） */
export function withBuiltinQueryPrefix(query: string): string {
  return query.startsWith(BUILTIN_QUERY_PREFIX) ? query : `${BUILTIN_QUERY_PREFIX}${query}`
}
