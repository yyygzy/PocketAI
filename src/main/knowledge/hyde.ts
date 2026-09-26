// HyDE（Hypothetical Document Embeddings）：用 LLM 基于用户查询生成一段假设性答案文档，
// 用该文档的 embedding 做向量检索，提升短查询/模糊查询的召回质量。
// 失败时返回 null，由调用方降级用原 query 检索。
import { providerManager } from '../providers/manager'

const HYDE_SYSTEM_PROMPT = `你是一个知识库内容生成助手。给定用户的问题，写一段大约 100-200 字的假设性答案段落。
这段文字应当像是从该主题的技术文档/百科条目中摘录的，风格平实、信息密集、包含相关术语。
不要解释，不要加标题，直接输出段落正文。`

/**
 * 生成假设文档。失败/无 adapter 返回 null。
 */
export async function generateHypotheticalDoc(
  query: string,
  providerId: string,
  model: string
): Promise<string | null> {
  const adapter = providerManager.getAdapter(providerId)
  if (!adapter) return null

  try {
    const result = await adapter.streamChat(
      [
        { role: 'system', content: HYDE_SYSTEM_PROMPT },
        { role: 'user', content: query }
      ],
      { model, temperature: 0.7, maxTokens: 400 },
      { onDelta: () => {} }
    )
    const text = result.content.trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}
