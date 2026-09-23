// 知识库分块数据访问 + 向量存储（纯 JS 余弦相似度 KNN）
// v1：embedding 以 Float32Array 序列化为 BLOB 存于 kb_chunks.embedding 列
// 后续可平滑切换 sqlite-vec 扩展以支持更大规模检索
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
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

function bufferToFloat32(buf: Buffer | null): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null
  // better-sqlite3 返回的 BLOB Buffer 可能非 4 字节对齐，Float32Array 要求对齐
  // 拷贝到新分配的 Buffer 以保证 byteOffset 为 0
  const aligned = Buffer.allocUnsafe(buf.byteLength)
  buf.copy(aligned)
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
}

function float32ToBuffer(vec: Float32Array): Buffer {
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
  /** 批量插入分块（含向量） */
  insertMany(chunks: ChunkInsert[]): void {
    if (chunks.length === 0) return
    const db = dbService.getHandle()
    const stmt = db.prepare(
      `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const now = Date.now()
    const tx = db.transaction((items: ChunkInsert[]) => {
      for (const c of items) {
        stmt.run(
          c.id ?? randomUUID(),
          c.docId,
          c.kbId,
          c.sequence,
          c.content,
          float32ToBuffer(c.embedding),
          now
        )
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
    dbService.getHandle().prepare('DELETE FROM kb_chunks WHERE doc_id=?').run(docId)
  },

  deleteByKb(kbId: string): void {
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
