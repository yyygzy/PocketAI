// RAG 检索服务：query → 向量化 + BM25 双路 → 混合重排 → 拼装 context
// v2 增强：向量检索 + BM25 全文检索，用 RRF（Reciprocal Rank Fusion）融合
import { kbRepo } from '../db/repositories/kb.repo'
import { kbChunkRepo } from '../db/repositories/kb-chunk.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { embedQuery } from './embedding'
import type { RetrievedChunk, RetrievalResult } from '../../shared/types'

export interface RetrieveOptions {
  topK?: number
  topN?: number
}

/** RRF 融合参数：rank 越高权重越低，k 控制衰减 */
const RRF_K = 60

/**
 * Reciprocal Rank Fusion：将多路检索结果的排名融合为单一分数
 * score = Σ 1 / (k + rank_i)
 */
export function rrfFuse(results: RetrievedChunk[][]): RetrievedChunk[] {
  const map = new Map<string, { chunk: RetrievedChunk; score: number }>()

  for (const list of results) {
    list.forEach((chunk, idx) => {
      const rank = idx + 1
      const key = chunk.chunkId
      const existing = map.get(key)
      const rrfScore = 1 / (RRF_K + rank)
      if (existing) {
        existing.score += rrfScore
      } else {
        map.set(key, { chunk, score: rrfScore })
      }
    })
  }

  // 按融合分数降序
  return Array.from(map.values())
    .sort((a, b) => b.score - a.score)
    .map((v) => ({ ...v.chunk, score: v.score }))
}

class RAGService {
  /**
   * 多知识库混合检索：每个 KB 分别执行向量检索 + BM25 全文检索，
   * 用 RRF 融合排名，最后合并取 Top-N
   */
  async retrieve(
    kbIds: string[],
    query: string,
    opts: RetrieveOptions = {}
  ): Promise<RetrievalResult> {
    const topK = opts.topK ?? 20
    const topN = opts.topN ?? 5
    const all: RetrievedChunk[] = []

    for (const kbId of kbIds) {
      const kb = kbRepo.get(kbId)
      if (!kb) continue

      // 收集两路检索结果
      const vectorResults: RetrievedChunk[] = []
      const bm25Results: RetrievedChunk[] = []

      // 1. 向量检索（需要 embedding 配置）
      if (kb.embeddingProviderId && kb.embeddingModel) {
        try {
          const qVec = await embedQuery(kb.embeddingProviderId, kb.embeddingModel, query)
          vectorResults.push(...kbChunkRepo.knnSearch(qVec, [kbId], topK))
        } catch {
          // 向量化失败不阻断，仅跳过向量检索
        }
      }

      // 2. BM25 全文检索
      try {
        bm25Results.push(...kbChunkRepo.bm25Search(query, [kbId], topK))
      } catch {
        // FTS 检索失败不阻断
      }

      // RRF 融合两路结果
      const fused = rrfFuse([vectorResults, bm25Results])
      all.push(...fused)
    }

    // 多 KB 合并后再次按融合分数排序，取 Top-N
    all.sort((a, b) => b.score - a.score)
    const picked = all.slice(0, topN)

    // 填充文档标题
    const titleCache = new Map<string, string>()
    for (const c of picked) {
      if (!titleCache.has(c.docId)) {
        const doc = kbDocRepo.get(c.docId)
        titleCache.set(c.docId, doc?.title || doc?.source || c.docId)
      }
      c.docTitle = titleCache.get(c.docId) ?? c.docId
    }

    return { query, chunks: picked }
  }

  /** 拼装注入到 SystemPrompt 的知识上下文 */
  buildContext(chunks: RetrievedChunk[]): string {
    if (chunks.length === 0) return ''
    const parts = chunks.map((c, i) => `[${i + 1}. ${c.docTitle}]\n${c.content}`)
    return `以下是相关知识库内容：\n\n${parts.join('\n\n---\n\n')}`
  }
}

export const ragService = new RAGService()
