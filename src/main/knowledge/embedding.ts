// Embedding 服务：批量向量化，调用用户配置的 Provider 的 embedding API
// v1 走 OpenAI 兼容 /v1/embeddings；后续可在此分派专用适配器
import { providerManager } from '../providers/manager'

const BATCH_SIZE = 32 // 单次请求最大文本数，避免 payload 过大

/** 批量向量化：把文本数组按批次请求，返回与输入等长的 Float32Array 数组 */
export async function embedTexts(
  providerId: string,
  model: string,
  texts: string[]
): Promise<Float32Array[]> {
  if (texts.length === 0) return []
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
  const adapter = providerManager.getAdapter(providerId)
  const [vec] = await adapter.embed([query], model)
  return Float32Array.from(vec!)
}
