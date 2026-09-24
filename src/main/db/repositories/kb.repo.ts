// 知识库数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
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
  created_at: number
}

interface KbCountRow {
  doc_count: number
  chunk_count: number
}

export function rowToRecord(row: KbRow): KnowledgeBase {
  const counts = dbService
    .getHandle()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM kb_documents WHERE kb_id=?) AS doc_count,
         (SELECT COUNT(*) FROM kb_chunks WHERE kb_id=?) AS chunk_count`
    )
    .get(row.id, row.id) as KbCountRow
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
    documentCount: counts.doc_count,
    chunkCount: counts.chunk_count,
    createdAt: row.created_at
  }
}

export const kbRepo = {
  list(): KnowledgeBase[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM knowledge_bases ORDER BY created_at ASC')
      .all() as KbRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): KnowledgeBase | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM knowledge_bases WHERE id=?')
      .get(id) as KbRow | undefined
    return row ? rowToRecord(row) : null
  },

  save(input: Partial<KnowledgeBase> & { name: string }): KnowledgeBase {
    const db = dbService.getHandle()
    const existing = input.id ? this.get(input.id) : null
    const id = input.id || randomUUID()

    if (existing) {
      db.prepare(
        `UPDATE knowledge_bases SET
           name=?, description=?, embedding_provider_id=?, embedding_model=?,
           embedding_dim=?, chunk_size=?, chunk_overlap=?, top_k=?, top_n=?
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
        id
      )
    } else {
      const now = Date.now()
      db.prepare(
        `INSERT INTO knowledge_bases
           (id, name, description, embedding_provider_id, embedding_model, embedding_dim,
            chunk_size, chunk_overlap, top_k, top_n, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now
      )
    }
    return mustGet(() => this.get(id), '知识库')
  },

  /** 首次入库确定向量维度后写回 */
  setEmbeddingDim(id: string, dim: number): void {
    dbService
      .getHandle()
      .prepare('UPDATE knowledge_bases SET embedding_dim=? WHERE id=?')
      .run(dim, id)
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM knowledge_bases WHERE id=?').run(id)
  }
}
