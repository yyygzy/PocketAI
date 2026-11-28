// 知识库数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { cachedPrepare } from '../statement-cache'
import { mustGet } from '../must-get'
import type { KnowledgeBase } from '../../../shared/types'

interface KbRow {
  id: string
  name: string
  description: string | null
  embedding_provider_id: string | null
  embedding_model: string | null
  embedding_dim: number | null
  chunk_size: number
  chunk_overlap: number
  top_k: number
  top_n: number
  min_score: number
  rerank_provider_id: string | null
  rerank_model: string | null
  hyde_provider_id: string | null
  hyde_model: string | null
  multiquery_provider_id: string | null
  multiquery_model: string | null
  ocr_provider_id: string | null
  ocr_model: string | null
  created_at: number
}

interface KbCountRow {
  doc_count: number
  chunk_count: number
}

/** PERF-07：列表/get 用聚合 JOIN 一次拿到计数；单行 rowToRecord 仍保留原查询兜底（外部有单测直接调用） */
const KB_WITH_COUNTS_SQL = `SELECT k.*,
       COALESCE(d.doc_count, 0) AS doc_count,
       COALESCE(c.chunk_count, 0) AS chunk_count
     FROM knowledge_bases k
     LEFT JOIN (SELECT kb_id, COUNT(*) AS doc_count FROM kb_documents GROUP BY kb_id) d ON d.kb_id = k.id
     LEFT JOIN (SELECT kb_id, COUNT(*) AS chunk_count FROM kb_chunks GROUP BY kb_id) c ON c.kb_id = k.id`

const KB_COUNT_SQL = `SELECT
       (SELECT COUNT(*) FROM kb_documents WHERE kb_id=?) AS doc_count,
       (SELECT COUNT(*) FROM kb_chunks WHERE kb_id=?) AS chunk_count`

export function rowToRecord(row: KbRow, counts?: KbCountRow): KnowledgeBase {
  const resolvedCounts =
    counts ??
    (cachedPrepare(dbService.getHandle(), KB_COUNT_SQL).get(row.id, row.id) as KbCountRow)
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    embeddingProviderId: row.embedding_provider_id,
    embeddingModel: row.embedding_model,
    embeddingDim: row.embedding_dim,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    topK: row.top_k,
    topN: row.top_n,
    minScore: row.min_score,
    rerankProviderId: row.rerank_provider_id,
    rerankModel: row.rerank_model,
    hydeProviderId: row.hyde_provider_id,
    hydeModel: row.hyde_model,
    multiQueryProviderId: row.multiquery_provider_id,
    multiQueryModel: row.multiquery_model,
    ocrProviderId: row.ocr_provider_id,
    ocrModel: row.ocr_model,
    documentCount: resolvedCounts.doc_count,
    chunkCount: resolvedCounts.chunk_count,
    createdAt: row.created_at
  }
}

export const kbRepo = {
  list(): KnowledgeBase[] {
    // PERF-07：N 行 × 2 条 COUNT 子查询 → 2 条 GROUP BY 聚合 + 1 条主查询，查询次数 O(1)
    const rows = cachedPrepare(
      dbService.getHandle(),
      `${KB_WITH_COUNTS_SQL} ORDER BY k.created_at ASC`
    ).all() as Array<KbRow & KbCountRow>
    return rows.map((row) => rowToRecord(row, row))
  },

  get(id: string): KnowledgeBase | null {
    const row = cachedPrepare(
      dbService.getHandle(),
      `${KB_WITH_COUNTS_SQL} WHERE k.id=?`
    ).get(id) as (KbRow & KbCountRow) | undefined
    return row ? rowToRecord(row, row) : null
  },

  save(input: Partial<KnowledgeBase> & { name: string }): KnowledgeBase {
    const db = dbService.getHandle()
    const existing = input.id ? this.get(input.id) : null
    const id = input.id || randomUUID()

    if (existing) {
      cachedPrepare(db,
        `UPDATE knowledge_bases SET
           name=?, description=?, embedding_provider_id=?, embedding_model=?,
           embedding_dim=?, chunk_size=?, chunk_overlap=?, top_k=?, top_n=?, min_score=?,
           rerank_provider_id=?, rerank_model=?, hyde_provider_id=?, hyde_model=?,
           multiquery_provider_id=?, multiquery_model=?, ocr_provider_id=?, ocr_model=?
         WHERE id=?`
      ).run(
        input.name,
        input.description ?? existing.description,
        input.embeddingProviderId ?? existing.embeddingProviderId,
        input.embeddingModel ?? existing.embeddingModel,
        input.embeddingDim ?? existing.embeddingDim,
        input.chunkSize ?? existing.chunkSize,
        input.chunkOverlap ?? existing.chunkOverlap,
        input.topK ?? existing.topK,
        input.topN ?? existing.topN,
        // 0 是合法值（=不过滤），?? 只在 undefined/null 时回退到旧值，不会被当成"没填"
        input.minScore ?? existing.minScore,
        input.rerankProviderId ?? existing.rerankProviderId,
        input.rerankModel ?? existing.rerankModel,
        input.hydeProviderId ?? existing.hydeProviderId,
        input.hydeModel ?? existing.hydeModel,
        input.multiQueryProviderId ?? existing.multiQueryProviderId,
        input.multiQueryModel ?? existing.multiQueryModel,
        input.ocrProviderId ?? existing.ocrProviderId,
        input.ocrModel ?? existing.ocrModel,
        id
      )
    } else {
      const now = Date.now()
      cachedPrepare(db,
        `INSERT INTO knowledge_bases
           (id, name, description, embedding_provider_id, embedding_model, embedding_dim,
            chunk_size, chunk_overlap, top_k, top_n, min_score, rerank_provider_id, rerank_model,
            hyde_provider_id, hyde_model, multiquery_provider_id, multiquery_model,
            ocr_provider_id, ocr_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.name,
        input.description ?? '',
        input.embeddingProviderId ?? null,
        input.embeddingModel ?? null,
        input.embeddingDim ?? null,
        input.chunkSize ?? 800,
        input.chunkOverlap ?? 200,
        input.topK ?? 20,
        input.topN ?? 5,
        input.minScore ?? 0,
        input.rerankProviderId ?? null,
        input.rerankModel ?? null,
        input.hydeProviderId ?? null,
        input.hydeModel ?? null,
        input.multiQueryProviderId ?? null,
        input.multiQueryModel ?? null,
        input.ocrProviderId ?? null,
        input.ocrModel ?? null,
        now
      )
    }
    return mustGet(() => this.get(id), '知识库')
  },

  /** 首次入库确定向量维度后写回 */
  setEmbeddingDim(id: string, dim: number): void {
    cachedPrepare(
      dbService.getHandle(),
      'UPDATE knowledge_bases SET embedding_dim=? WHERE id=?'
    ).run(dim, id)
  },

  delete(id: string): void {
    cachedPrepare(dbService.getHandle(), 'DELETE FROM knowledge_bases WHERE id=?').run(id)
  }
}
