// RAG 检索重排序：用 LLM 对候选 chunk 做相关性打分，重排后取 topN
// 失败/无配置时降级返回原顺序（不阻断检索）
import { z } from 'zod'
import { providerManager } from '../providers/manager'
import type { AdapterChatMessage } from '../providers/types'
import { errMsg } from '../error'
import { generateStructured, describeStructuredError } from '../agent/structured-output'
import type { StructuredOutputError } from '../agent/structured-output'
import type { RetrievedChunk } from '../../shared/types'

/** 单个候选片段送给 LLM 的最大字符数（控制 prompt 体积） */
const MAX_CHUNK_CHARS = 400

const RERANK_SYSTEM_PROMPT = `你是文档检索相关性评估器。给定用户查询和若干候选文档片段，评估每个片段与查询的相关程度。
严格只输出一个 JSON 数组，格式：[{"id":1,"score":0.95},{"id":2,"score":0.3},...]
- id：候选片段编号（从 1 开始）
- score：0 到 1 的浮点数，越接近 1 越相关
按相关度从高到低排序。不要输出任何解释、markdown 代码块或其他文字。`

/**
 * 严格评分契约：
 * - id 是 1..count 的整数（兼容旧解析已接受的数字字符串），score 是 0..1 的浮点数；
 * - `.strict()` 让模型多给的字段按「编造」报出来，而不是静默丢弃；
 * - 完整性（每个候选恰好一次）与「至少一个非零分」用 superRefine 表达。
 * 注意：校验失败不直接失败——调用方会先尝试一次修复，再退回 parseRerankScores 的兼容解析。
 */
function buildRerankSchema(count: number) {
  // 旧解析接受数字与数字字符串两种 id；这里保持同一接受面，但拒绝布尔/小数/越界
  const idSchema = z
    .union([z.number(), z.string().regex(/^\d+$/)])
    .transform(Number)
    .pipe(z.number().int().min(1).max(count))

  return z
    .array(
      z.strictObject({
        id: idSchema,
        score: z.number().min(0).max(1)
      })
    )
    .min(1)
    .superRefine((items, ctx) => {
      const seen = new Set<number>()
      items.forEach((item, index) => {
        if (seen.has(item.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'id'],
            message: `重复的候选编号 ${item.id}`
          })
        }
        seen.add(item.id)
      })
      for (let id = 1; id <= count; id++) {
        if (!seen.has(id)) {
          ctx.addIssue({ code: 'custom', path: [], message: `缺少候选编号 ${id} 的评分` })
        }
      }
      if (!items.some((item) => item.score > 0)) {
        ctx.addIssue({ code: 'custom', path: [], message: '所有评分都是 0，无法区分相关度' })
      }
    })
}

/** 修复轮 prompt：把不合规路径交回模型，只要求它重发 JSON */
function buildRerankRepairPrompt(error: StructuredOutputError): string {
  return [
    '上一次输出不符合要求的 JSON 结构，请只输出修正后的 JSON 数组，不要解释、不要 markdown 代码块。',
    `问题：${describeStructuredError(error)}`,
    '格式：[{"id":1,"score":0.95},{"id":2,"score":0.3}]；id 必须覆盖 1 到候选总数且不能重复，score 必须在 0 到 1 之间。'
  ].join('\n')
}

function sortByScores(chunks: RetrievedChunk[], scores: number[]): RetrievedChunk[] {
  const scored = chunks.map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }))
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => ({ ...s.chunk, score: s.score }))
}

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
 * @param onDegrade 降级原因回调（A3：以前「模型调用失败」「输出解析不出分」「没有 adapter」
 *   与「重排后恰好还是这个顺序」在外部完全无法区分，于是注入质量掉一档没人知道）
 */
export async function rerankChunks(
  query: string,
  chunks: RetrievedChunk[],
  providerId: string,
  model: string,
  onDegrade?: (reason: string) => void
): Promise<RetrievedChunk[]> {
  // 只有一条候选时无需重排，这不算降级
  if (chunks.length <= 1) return chunks

  const adapter = providerManager.getAdapter(providerId)
  if (!adapter) {
    onDegrade?.(`找不到服务商 adapter：${providerId}`)
    return chunks
  }

  const candidatesText = chunks
    .map((c, i) => `[${i + 1}] ${c.content.slice(0, MAX_CHUNK_CHARS)}`)
    .join('\n\n')

  const userPrompt = `查询：${query}\n\n候选片段：\n${candidatesText}\n\n请输出相关性评分 JSON。`

  try {
    let lastRaw = ''
    const result = await generateStructured({
      schema: buildRerankSchema(chunks.length),
      // 评分数组可能很长；兼容解析的回退需要完整原文，不能只看 500 字
      maxRawChars: 2000,
      generate: async (repair) => {
        const messages: AdapterChatMessage[] = [
          { role: 'system', content: RERANK_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ]
        if (repair) {
          // 空响应不占一条空的 assistant 消息（部分服务商不接受空 content）
          if (repair.raw) messages.push({ role: 'assistant', content: repair.raw })
          messages.push({ role: 'user', content: buildRerankRepairPrompt(repair) })
        }
        const response = await adapter.streamChat(
          messages,
          { model, temperature: 0, maxTokens: 1024 },
          { onDelta: () => {} }
        )
        lastRaw = response.content ?? ''
        return lastRaw
      }
    })

    if (result.ok) {
      const scores = new Array<number>(chunks.length).fill(0)
      for (const item of result.data) scores[item.id - 1] = item.score
      return sortByScores(chunks, scores)
    }

    // 契约校验失败：先退回旧的兼容解析（保留「部分 id 缺失填 0 / 越界忽略 / 字符串 id」
    // 等行为），只有兼容解析也拿不到非零分时才真正放弃重排。
    const fallbackScores = parseRerankScores(lastRaw, chunks.length)
    if (fallbackScores) {
      onDegrade?.(
        `模型输出不符合严格评分契约，已按兼容解析降级（${describeStructuredError(result.error)}）`
      )
      return sortByScores(chunks, fallbackScores)
    }

    onDegrade?.(
      `模型输出的评分 JSON 解析不出任何非零分，顺序退回 RRF 融合序（${describeStructuredError(result.error)}）`
    )
    return chunks
  } catch (e) {
    onDegrade?.(`重排调用失败：${errMsg(e, '未知错误')}`)
    return chunks
  }
}
