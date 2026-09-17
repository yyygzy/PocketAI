// RAG 检索服务：query → 向量化 → KNN 检索 → 重排 → 拼装 context
// v1 重排用向量分数排序（Top-K → Top-N），不引入额外 reranker 模型
import { kbRepo } from '../db/repositories/kb.repo'
import { kbChunkRepo } from '../db/repositories/kb-chunk.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { embedQuery } from './embedding'
import type { RetrievedChunk, RetrievalResult } from '../../shared/types'

export interface RetrieveOptions {
  topK?: number
  topN?: number
}

class RAGService {
  /**
   * 多知识库检索：每个 KB 用各自的 embedding 模型向量化查询，
   * 在各自范围内做 KNN，最后合并按分数取 Top-N
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
      if (!kb || !kb.embeddingProviderId || !kb.embeddingModel) continue

      const qVec = await embedQuery(kb.embeddingProviderId, kb.embeddingModel, query)
      const hits = kbChunkRepo.knnSearch(qVec, [kbId], topK)
      all.push(...hits)
    }

    // 合并后按分数降序，取 Top-N
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
    const parts = chunks.map((c) => `[${c.docTitle}]\n${c.content}`)
    return `以下是相关知识库内容：\n\n${parts.join('\n\n---\n\n')}`
  }
}

export const ragService = new RAGService()
