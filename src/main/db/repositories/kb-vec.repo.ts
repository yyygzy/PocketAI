// sqlite-vec 向量索引管理：按维度建 vec0 虚拟表，rowid 映射到 kb_chunks.id
// 失败/不可用时由 kb-chunk.repo 降级为纯 JS 余弦 KNN
import { dbService } from '../database'
import { float32ToBuffer } from './kb-chunk.repo'

const MAP_TABLE = 'kb_vec_map'

function vecTableName(dim: number): string {
  return `kb_vec_${dim}`
}

export const kbVecRepo = {
  /** 确保某维度的 vec0 表与映射表存在（幂等） */
  ensureTable(dim: number): void {
    const db = dbService.getHandle()
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${MAP_TABLE} (
         chunk_id TEXT PRIMARY KEY,
         vec_rowid INTEGER NOT NULL,
         dim INTEGER NOT NULL
       )`
    )
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(dim)} USING vec0(embedding float[${dim}])`
    )
  },

  /** 写入一个向量，返回 vec0 表的 rowid */
  insert(chunkId: string, embedding: Float32Array, dim: number): number {
    this.ensureTable(dim)
    const db = dbService.getHandle()
    // 先删旧映射（重建索引场景）
    db.prepare(`DELETE FROM ${MAP_TABLE} WHERE chunk_id=?`).run(chunkId)
    const info = db
      .prepare(`INSERT INTO ${vecTableName(dim)}(embedding) VALUES (?)`)
      .run(float32ToBuffer(embedding))
    const vecRowid = Number(info.lastInsertRowid)
    db.prepare(`INSERT INTO ${MAP_TABLE}(chunk_id, vec_rowid, dim) VALUES (?, ?, ?)`).run(
      chunkId,
      vecRowid,
      dim
    )
    return vecRowid
  },

  /** 删除单个 chunk 的向量索引 */
  deleteByChunk(chunkId: string): void {
    const db = dbService.getHandle()
    const row = db.prepare(`SELECT vec_rowid, dim FROM ${MAP_TABLE} WHERE chunk_id=?`).get(chunkId) as
      | { vec_rowid: number; dim: number }
      | undefined
    if (!row) return
    db.prepare(`DELETE FROM ${vecTableName(row.dim)} WHERE rowid=?`).run(row.vec_rowid)
    db.prepare(`DELETE FROM ${MAP_TABLE} WHERE chunk_id=?`).run(chunkId)
  },

  /** 删除某文档全部分块的向量索引 */
  deleteByDoc(docId: string): void {
    const db = dbService.getHandle()
    const rows = db
      .prepare(
        `SELECT m.chunk_id, m.vec_rowid, m.dim FROM ${MAP_TABLE} m
         JOIN kb_chunks c ON c.id = m.chunk_id
         WHERE c.doc_id = ?`
      )
      .all(docId) as Array<{ chunk_id: string; vec_rowid: number; dim: number }>
    for (const r of rows) {
      db.prepare(`DELETE FROM ${vecTableName(r.dim)} WHERE rowid=?`).run(r.vec_rowid)
    }
    if (rows.length > 0) {
      const ids = rows.map((r) => r.chunk_id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`DELETE FROM ${MAP_TABLE} WHERE chunk_id IN (${placeholders})`).run(...ids)
    }
  },

  /** 删除某知识库全部分块的向量索引 */
  deleteByKb(kbId: string): void {
    const db = dbService.getHandle()
    const rows = db
      .prepare(
        `SELECT m.chunk_id, m.vec_rowid, m.dim FROM ${MAP_TABLE} m
         JOIN kb_chunks c ON c.id = m.chunk_id
         WHERE c.kb_id = ?`
      )
      .all(kbId) as Array<{ chunk_id: string; vec_rowid: number; dim: number }>
    for (const r of rows) {
      db.prepare(`DELETE FROM ${vecTableName(r.dim)} WHERE rowid=?`).run(r.vec_rowid)
    }
    if (rows.length > 0) {
      const ids = rows.map((r) => r.chunk_id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`DELETE FROM ${MAP_TABLE} WHERE chunk_id IN (${placeholders})`).run(...ids)
    }
  },

  /**
   * 向量 KNN 检索（sqlite-vec，距离为欧氏距离，越小越近）。
   * 返回的 score 转换为相似度：1 / (1 + distance)，与纯 JS 余弦分数语义一致（越大越相关）。
   */
  search(
    query: Float32Array,
    kbIds: string[],
    dim: number,
    topK: number
  ): Array<{ chunkId: string; docId: string; content: string; score: number }> {
    if (kbIds.length === 0) return []
    this.ensureTable(dim)
    const db = dbService.getHandle()
    const placeholders = kbIds.map(() => '?').join(',')
    // 子查询先在 vec0 表上完成 KNN（带 LIMIT，sqlite-vec 要求），再 JOIN 映射与分块表
    const rows = db
      .prepare(
        `SELECT c.id AS chunk_id, c.doc_id, c.content, v.distance
         FROM (
           SELECT rowid, distance FROM ${vecTableName(dim)}
           WHERE embedding MATCH ?
           ORDER BY distance ASC
           LIMIT ?
         ) v
         JOIN ${MAP_TABLE} m ON m.vec_rowid = v.rowid AND m.dim = ?
         JOIN kb_chunks c ON c.id = m.chunk_id
         WHERE c.kb_id IN (${placeholders})
         ORDER BY v.distance ASC`
      )
      .all(float32ToBuffer(query), topK, dim, ...kbIds) as Array<{
      chunk_id: string
      doc_id: string
      content: string
      distance: number
    }>
    return rows.slice(0, topK).map((r) => ({
      chunkId: r.chunk_id,
      docId: r.doc_id,
      content: r.content,
      score: 1 / (1 + r.distance)
    }))
  }
}
