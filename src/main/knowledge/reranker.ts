// RAG 检索重排序：用 LLM 对候选 chunk 做相关性打分，重排后取 topN
// 失败/无配置时降级返回原顺序（不阻断检索）
import { providerManager } from '../providers/manager'
import type { RetrievedChunk } from '../../shared/types'

/** 单个候选片段送给 LLM 的最大字符数（控制 prompt 体积） */
const MAX_CHUNK_CHARS = 400

const RERANK_SYSTEM_PROMPT = `你是文档检索相关性评估器。给定用户查询和若干候选文档片段，评估每个片段与查询的相关程度。
严格只输出一个 JSON 数组，格式：[{"id":1,"score":0.95},{"id":2,"score":0.3},...]
- id：候选片段编号（从 1 开始）
- score：0 到 1 的浮点数，越接近 1 越相关
按相关度从高到低排序。不要输出任何解释、markdown 代码块或其他文字。`

/** 从 LLM 输出中鲁棒提取评分数组 */
export function parseRerankScores(text: string, count: number): number[] | null {
  // 提取第一个 JSON 数组
  const match = text.match(/\[[\s\S]*?\]/)
  if (!match) return null
  let arr: unknown
  try {
    arr = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const scores = new Array<number>(count).fill(0)
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    const score = (item as { score?: unknown }).score
    const idx = typeof id === 'number' ? id - 1 : typeof id === 'string' ? Number(id) - 1 : -1
    if (idx >= 0 && idx < count && typeof score === 'number' && score >= 0 && score <= 1) {
      scores[idx] = score
    }
  }
  // 至少有一个非零分才算解析成功
  return scores.some((s) => s > 0) ? scores : null
}

/**
 * LLM-based rerank：调 LLM 对候选 chunks 打相关性分，按分数降序重排。
 * 任何异常（无 adapter、调用失败、解析失败）均降级返回原数组。
 */
export async function rerankChunks(
  query: string,
  chunks: RetrievedChunk[],
  providerId: string,
  model: string
): Promise<RetrievedChunk[]> {
  if (chunks.length <= 1) return chunks

  const adapter = providerManager.getAdapter(providerId)
  if (!adapter) return chunks

  const candidatesText = chunks
    .map((c, i) => `[${i + 1}] ${c.content.slice(0, MAX_CHUNK_CHARS)}`)
    .join('\n\n')

  const userPrompt = `查询：${query}\n\n候选片段：\n${candidatesText}\n\n请输出相关性评分 JSON。`

  try {
    const result = await adapter.streamChat(
      [
        { role: 'system', content: RERANK_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      { model, temperature: 0, maxTokens: 1024 },
      { onDelta: () => {} }
    )

    const scores = parseRerankScores(result.content, chunks.length)
    if (!scores) return chunks

    const scored = chunks.map((c, i) => ({ chunk: c, score: scores[i] ?? 0 }))
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => ({ ...s.chunk, score: s.score }))
  } catch {
    return chunks
  }
}
