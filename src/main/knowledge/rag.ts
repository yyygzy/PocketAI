// RAG 检索服务：query → 向量化 + BM25 双路 → 混合重排 → 拼装 context
// v2 增强：向量检索 + BM25 全文检索，用 RRF（Reciprocal Rank Fusion）融合
import { kbRepo } from '../db/repositories/kb.repo'
import { kbChunkRepo } from '../db/repositories/kb-chunk.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { embedQuery } from './embedding'
import { rerankChunks } from './reranker'
import { generateHypotheticalDoc } from './hyde'
import { generateMultiQueries } from './multi-query'
import { mmrSelect } from './mmr'
import { recordPerf, logPerfDebug } from '../steward/perf-probe'
import type { RetrievedChunk, RetrievalDiagnostics, RetrievalResult } from '../../shared/types'

/** 检索总耗时入慢操作缓冲的阈值 */
const SLOW_RETRIEVE_MS = 800

export interface RetrieveOptions {
  topK?: number
  topN?: number
}

/** RRF 融合参数：rank 越高权重越低，k 控制衰减 */
const RRF_K = 60

/** 检索来源路标识 */
export type RetrievalSource = 'vector' | 'bm25'

/**
 * Reciprocal Rank Fusion：将多路检索结果的排名融合为单一分数
 * score = Σ 1 / (k + rank_i)
 * 每路可附带来源标识，融合后的 chunk.sources 记录命中过哪些路
 */
export function rrfFuse(
  results: RetrievedChunk[][],
  sourceTags?: RetrievalSource[]
): RetrievedChunk[] {
  const map = new Map<string, { chunk: RetrievedChunk; score: number; sources: Set<RetrievalSource> }>()

  results.forEach((list, listIdx) => {
    const tag = sourceTags?.[listIdx]
    list.forEach((chunk, idx) => {
      const rank = idx + 1
      const key = chunk.chunkId
      const rrfScore = 1 / (RRF_K + rank)
      const existing = map.get(key)
      if (existing) {
        existing.score += rrfScore
        if (tag) existing.sources.add(tag)
      } else {
        const sources = new Set<RetrievalSource>()
        if (tag) sources.add(tag)
        map.set(key, { chunk, score: rrfScore, sources })
      }
    })
  })

  // 按融合分数降序
  return Array.from(map.values())
    .sort((a, b) => b.score - a.score)
    .map((v) => ({
      ...v.chunk,
      score: v.score,
      sources: sourceTags ? Array.from(v.sources) : v.chunk.sources
    }))
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
    return this.retrieveInternal(kbIds, query, opts, null)
  }

  /**
   * 检索测试面板用：同 retrieve，但附带诊断信息（来源路标记/查询变体/各路命中数）。
   * 与聊天主链路同一条检索逻辑，保证面板所见即实际注入效果。
   */
  async retrieveWithDiagnostics(
    kbIds: string[],
    query: string,
    opts: RetrieveOptions = {}
  ): Promise<{ result: RetrievalResult; diagnostics: RetrievalDiagnostics }> {
    const diagnostics: RetrievalDiagnostics = {
      hydeUsed: false,
      queryVariants: [],
      vectorHits: 0,
      bm25Hits: 0,
      rerankUsed: false,
      candidateCount: 0
    }
    const result = await this.retrieveInternal(kbIds, query, opts, diagnostics)
    return { result, diagnostics }
  }

  /** 检索核心：diag 非空时收集诊断信息 */
  private async retrieveInternal(
    kbIds: string[],
    query: string,
    opts: RetrieveOptions,
    diag: RetrievalDiagnostics | null
  ): Promise<RetrievalResult> {
    const topK = opts.topK ?? 20
    const topN = opts.topN ?? 5
    const tTotal = performance.now()
    let hydeMs = 0
    let multiQueryMs = 0
    const all: RetrievedChunk[] = []
    let rerankProvider: string | null = null
    let rerankModel: string | null = null
    let hydeProvider: string | null = null
    let hydeModel: string | null = null
    let multiQueryProvider: string | null = null
    let multiQueryModel: string | null = null

    // 取第一个配置了 hyde/rerank/multiQuery 的 KB（同一会话内统一）
    for (const kbId of kbIds) {
      const kb = kbRepo.get(kbId)
      if (!kb) continue
      if (!hydeProvider && kb.hydeProviderId && kb.hydeModel) {
        hydeProvider = kb.hydeProviderId
        hydeModel = kb.hydeModel
      }
      if (!rerankProvider && kb.rerankProviderId && kb.rerankModel) {
        rerankProvider = kb.rerankProviderId
        rerankModel = kb.rerankModel
      }
      if (!multiQueryProvider && kb.multiQueryProviderId && kb.multiQueryModel) {
        multiQueryProvider = kb.multiQueryProviderId
        multiQueryModel = kb.multiQueryModel
      }
    }

    // HyDE：用假设文档做向量检索的 embedding，BM25 仍用原 query
    const tHyde = performance.now()
    const hydeDoc = hydeProvider && hydeModel
      ? await generateHypotheticalDoc(query, hydeProvider, hydeModel)
      : null
    hydeMs = performance.now() - tHyde
    const embedText = hydeDoc ?? query
    if (diag) diag.hydeUsed = hydeDoc !== null

    // Multi-Query：LLM 改写出多个视角变体查询（失败降级为仅原 query）
    const tMq = performance.now()
    const variants =
      multiQueryProvider && multiQueryModel
        ? (await generateMultiQueries(query, multiQueryProvider, multiQueryModel)) ?? []
        : []
    multiQueryMs = performance.now() - tMq
    // 原 query 在前：向量路可用 HyDE 文本，变体只用自身
    const queryVariants: Array<{ q: string; useHyde: boolean }> = [
      { q: query, useHyde: true },
      ...variants.map((v) => ({ q: v, useHyde: false }))
    ]
    if (diag) diag.queryVariants = queryVariants.map((v) => v.q)

    const tSearch = performance.now()
    for (const kbId of kbIds) {
      const kb = kbRepo.get(kbId)
      if (!kb) continue

      // 收集全部查询的双路检索结果（原 query + 变体），统一 RRF 融合
      const vectorResults: RetrievedChunk[] = []
      const bm25Results: RetrievedChunk[] = []

      for (const { q, useHyde } of queryVariants) {
        // 1. 向量检索（原 query 在 HyDE 开启时用假设文档 embedding）
        if (kb.embeddingProviderId && kb.embeddingModel) {
          try {
            const qVec = await embedQuery(
              kb.embeddingProviderId,
              kb.embeddingModel,
              useHyde ? embedText : q
            )
            vectorResults.push(...kbChunkRepo.knnSearch(qVec, [kbId], topK))
          } catch {
            // 向量化失败不阻断，仅跳过该查询的向量检索
          }
        }

        // 2. BM25 全文检索
        try {
          bm25Results.push(...kbChunkRepo.bm25Search(q, [kbId], topK))
        } catch {
          // FTS 检索失败不阻断
        }
      }

      if (diag) {
        diag.vectorHits += vectorResults.length
        diag.bm25Hits += bm25Results.length
      }

      // RRF 融合两路结果（带来源标记）
      const fused = rrfFuse([vectorResults, bm25Results], ['vector', 'bm25'])
      all.push(...fused)
    }

    // 多 KB 合并后再次按融合分数排序
    all.sort((a, b) => b.score - a.score)
    const searchMs = performance.now() - tSearch

    // 3. 重排序：取 topK 候选给 LLM rerank
    const candidates = all.slice(0, topK)
    if (diag) {
      diag.candidateCount = candidates.length
      diag.rerankUsed = !!(rerankProvider && rerankModel)
    }
    const tRerank = performance.now()
    const reranked =
      rerankProvider && rerankModel
        ? await rerankChunks(query, candidates, rerankProvider, rerankModel)
        : candidates
    const rerankMs = performance.now() - tRerank

    // 4. MMR 多样性选择：在相关性与去重之间权衡后取 topN
    const tMmr = performance.now()
    let picked: RetrievedChunk[]
    try {
      const vecs = kbChunkRepo.loadEmbeddingsByIds(reranked.map((c) => c.chunkId))
      picked = mmrSelect(reranked, vecs, topN)
    } catch {
      picked = reranked.slice(0, topN)
    }
    const mmrMs = performance.now() - tMmr

    // 填充文档标题
    const titleCache = new Map<string, string>()
    for (const c of picked) {
      if (!titleCache.has(c.docId)) {
        const doc = kbDocRepo.get(c.docId)
        titleCache.set(c.docId, doc?.title || doc?.source || c.docId)
      }
      c.docTitle = titleCache.get(c.docId) ?? c.docId
    }

    // 性能埋点：主链路仅两次时间戳开销；超阈值入慢操作缓冲（数据健康面板可见）
    const totalMs = performance.now() - tTotal
    const timings = {
      hydeMs: Math.round(hydeMs),
      multiQueryMs: Math.round(multiQueryMs),
      searchMs: Math.round(searchMs),
      rerankMs: Math.round(rerankMs),
      mmrMs: Math.round(mmrMs),
      totalMs: Math.round(totalMs)
    }
    if (diag) diag.timings = timings
    const detail = `kbs=${kbIds.length} search=${timings.searchMs} rerank=${timings.rerankMs} mmr=${timings.mmrMs} picked=${picked.length}`
    if (totalMs >= SLOW_RETRIEVE_MS) recordPerf('kb.retrieve', totalMs, detail)
    else logPerfDebug('kb.retrieve', totalMs, detail)

    return { query, chunks: picked }
  }

  /** 拼装注入到 SystemPrompt 的知识上下文（带编号引用指令，正文 [n] 与 sources 顺序一一对应） */
  buildContext(chunks: RetrievedChunk[]): string {
    if (chunks.length === 0) return ''
    const parts = chunks.map((c, i) => `[${i + 1}. ${c.docTitle}]\n${c.content}`)
    return (
      '以下是相关知识库内容。回答时请依据这些内容，并在引用到的句子末尾用编号标注来源（如 [1]、[2]）；' +
      '知识库中没有的信息不要编造。\n\n' +
      parts.join('\n\n---\n\n')
    )
  }
}

export const ragService = new RAGService()
