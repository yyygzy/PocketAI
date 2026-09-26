// 知识库分块数据访问 + 向量存储（纯 JS 余弦相似度 KNN）
// v1：embedding 以 Float32Array 序列化为 BLOB 存于 kb_chunks.embedding 列
// 后续可平滑切换 sqlite-vec 扩展以支持更大规模检索
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { kbVecRepo } from './kb-vec.repo'
import type { KbChunk, RetrievedChunk } from '../../../shared/types'

export interface ChunkInsert {
  id?: string
  docId: string
  kbId: string
  sequence: number
  content: string
  embedding: Float32Array
}

export interface IndexedChunk {
  id: string
  docId: string
  kbId: string
  content: string
  embedding: Float32Array | null
}

export interface ChunkRow {
  id: string
  doc_id: string
  kb_id: string
  sequence: number
  content: string
  embedding: Buffer | null
  created_at: number
}

export function bufferToFloat32(buf: Buffer | null): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null
  // better-sqlite3 返回的 BLOB Buffer 可能非 4 字节对齐，Float32Array 要求对齐
  // 拷贝到新分配的 Buffer 以保证 byteOffset 为 0
  const aligned = Buffer.allocUnsafe(buf.byteLength)
  buf.copy(aligned)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

function rowToChunk(row: ChunkRow): KbChunk {
  return {
    id: row.id,
    docId: row.doc_id,
    kbId: row.kb_id,
    sequence: row.sequence,
    content: row.content,
    createdAt: row.created_at
  }
}

export const kbChunkRepo = {
  /** 批量插入分块（含向量）；vec 扩展可用时同步写入向量索引 */
  insertMany(chunks: ChunkInsert[]): void {
    if (chunks.length === 0) return
    const db = dbService.getHandle()
    const vecEnabled = dbService.isVecEnabled()
    const stmt = db.prepare(
      `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    const tx = db.transaction((items: ChunkInsert[]) => {
      for (const c of items) {
        const id = c.id ?? randomUUID()
        stmt.run(
          id,
          c.docId,
          c.kbId,
          c.sequence,
          c.content,
          float32ToBuffer(c.embedding),
          now
        )
        if (vecEnabled) {
          kbVecRepo.insert(id, c.embedding, c.embedding.length)
        }
      }
    })
    tx(chunks)
  },

  /** 列出某文档的分块（不含向量，供预览） */
  listByDoc(docId: string, limit = 200): KbChunk[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_chunks WHERE doc_id=? ORDER BY sequence ASC LIMIT ?')
      .all(docId, limit) as ChunkRow[]
    return rows.map(rowToChunk)
  },

  deleteByDoc(docId: string): void {
    if (dbService.isVecEnabled()) kbVecRepo.deleteByDoc(docId)
    dbService.getHandle().prepare('DELETE FROM kb_chunks WHERE doc_id=?').run(docId)
  },

  deleteByKb(kbId: string): void {
    if (dbService.isVecEnabled()) kbVecRepo.deleteByKb(kbId)
    dbService.getHandle().prepare('DELETE FROM kb_chunks WHERE kb_id=?').run(kbId)
  },

  /** 加载某知识库全部已索引分块（含向量），用于 KNN 检索 */
  loadIndexed(kbId: string): IndexedChunk[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM kb_chunks WHERE kb_id=? AND embedding IS NOT NULL')
      .all(kbId) as ChunkRow[]
    return rows.map((r) => ({
      id: r.id,
      docId: r.doc_id,
      kbId: r.kb_id,
      content: r.content,
      embedding: bufferToFloat32(r.embedding)
    }))
  },

  /** 按分块 id 批量加载向量（用于 MMR 多样性重排）；无向量的 id 不出现在结果中 */
  loadEmbeddingsByIds(ids: string[]): Map<string, Float32Array> {
    const result = new Map<string, Float32Array>()
    if (ids.length === 0) return result
    const placeholders = ids.map(() => '?').join(',')
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT id, embedding FROM kb_chunks WHERE id IN (${placeholders}) AND embedding IS NOT NULL`
      )
      .all(...ids) as Array<{ id: string; embedding: Buffer | null }>
    for (const r of rows) {
      const vec = bufferToFloat32(r.embedding)
      if (vec) result.set(r.id, vec)
    }
    return result
  },

  /**
   * 余弦相似度 KNN 检索
   * @param query 查询向量
   * @param kbIds 在这些知识库中检索
   * @param topK 返回前 K 条
   * @returns 按分数降序排列
   */
  knnSearch(
    query: Float32Array,
    kbIds: string[],
    topK: number
  ): RetrievedChunk[] {
    if (kbIds.length === 0) return []

    // sqlite-vec 可用时走原生向量索引（欧氏距离，远快于全表扫描）
    if (dbService.isVecEnabled()) {
      const hits = kbVecRepo.search(query, kbIds, query.length, topK)
      return hits.map((h) => ({
        chunkId: h.chunkId,
        docId: h.docId,
        docTitle: '',
        content: h.content,
        score: h.score
      }))
    }

    const db = dbService.getHandle()

    // 收集候选分块（多 KB 合并检索）
    const placeholders = kbIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT c.id, c.doc_id, c.kb_id, c.content, c.embedding
         FROM kb_chunks c
         WHERE c.kb_id IN (${placeholders}) AND c.embedding IS NOT NULL`
      )
      .all(...kbIds) as ChunkRow[]

    const scored: RetrievedChunk[] = []
    for (const r of rows) {
      const vec = bufferToFloat32(r.embedding)
      if (!vec || vec.length !== query.length) continue
      const score = cosineSimilarity(query, vec)
      scored.push({
        chunkId: r.id,
        docId: r.doc_id,
        docTitle: '', // 由调用方 join 文档标题
        content: r.content,
        score
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  },

  /**
   * BM25 全文检索（基于 kb_chunks_fts FTS5 表）
   * @param query 查询文本
   * @param kbIds 在这些知识库中检索
   * @param topK 返回前 K 条
   * @returns 按 BM25 分数降序排列（score 为原始 BM25 值，越大越相关）
   */
  bm25Search(
    query: string,
    kbIds: string[],
    topK: number
  ): RetrievedChunk[] {
    if (kbIds.length === 0 || !query.trim()) return []
    const db = dbService.getHandle()

    // 检查 FTS 表是否存在（兼容旧库未迁移的情况）
    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts'"
    ).get()
    if (!ftsExists) return []

    // 构造 FTS5 MATCH 查询：对查询分词，用 OR 连接（宽松匹配）
    // 用双引号包裹每个 token 避免特殊字符
    const tokens = query.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    const matchExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')

    const placeholders = kbIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT f.content, f.doc_id, f.kb_id, f.chunk_id, bm25(kb_chunks_fts) AS score
         FROM kb_chunks_fts f
         WHERE f.kb_chunks_fts MATCH ? AND f.kb_id IN (${placeholders})
         ORDER BY score ASC
         LIMIT ?`
      )
      .all(matchExpr, ...kbIds, topK) as Array<{ content: string; doc_id: string; kb_id: string; chunk_id: string; score: number }>

    // FTS5 bm25() 返回值越小越相关，取负数使降序排列时相关的在前
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      docId: r.doc_id,
      docTitle: '',
      content: r.content,
      score: -r.score
    }))
  }
}

/** 余弦相似度：dot(a,b) / (|a|*|b|)；零向量返回 0（避免 NaN 污染排序） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
