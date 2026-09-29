// Multi-Query 多查询扩展：用 LLM 把用户查询改写成多个不同视角的等价查询，
// 每个变体独立走 向量 + BM25 双路检索，结果与原查询一起 RRF 融合，
// 覆盖同义词/相关术语/上下位概念，提升单一措辞查询的召回质量。
// 失败时返回 null，由调用方降级为仅用原 query 检索。
import { providerManager } from '../providers/manager'

const MULTI_QUERY_SYSTEM_PROMPT = `你是检索查询改写助手。给定用户的检索问题，把它改写成 3-4 个不同视角、不同措辞的等价检索查询，覆盖同义词、相关术语、上下位概念，帮助从知识库中召回更多相关内容。
要求：
- 每行一个查询，共 3-4 行
- 不要编号、不要解释、不要加引号
- 保持与原问题相同的语言`

/** 变体查询数量上限（超过截断） */
export const MAX_MULTI_QUERIES = 4
/** 单条变体长度上限（过长视为模型输出异常，丢弃该条） */
export const MAX_VARIANT_CHARS = 200

/**
 * 解析 LLM 输出为变体查询列表（纯函数）：
 * 按行切分 → 去行首序号/列表前缀 → trim/去空 → 丢弃超长 → 去重 → 限量
 */
export function parseMultiQueries(
  text: string,
  max = MAX_MULTI_QUERIES
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw.trim()
    // 去常见序号前缀："1."、"1、"、"1)"、"-"、"*"
    line = line.replace(/^(?:\d+[.、)]|[-*])\s*/, '').trim()
    if (!line || line.length > MAX_VARIANT_CHARS) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= max) break
  }
  return out
}

/**
 * 生成变体查询。失败/无 adapter/解析为空返回 null。
 */
export async function generateMultiQueries(
  query: string,
  providerId: string,
  model: string
): Promise<string[] | null> {
  const adapter = providerManager.getAdapter(providerId)
  if (!adapter) return null

  try {
    const result = await adapter.streamChat(
      [
        { role: 'system', content: MULTI_QUERY_SYSTEM_PROMPT },
        { role: 'user', content: query }
      ],
      { model, temperature: 0.7, maxTokens: 400 },
      { onDelta: () => {} }
    )
    const parsed = parseMultiQueries(result.content)
    return parsed.length > 0 ? parsed : null
  } catch {
    return null
  }
}
