// sqlite-vec 向量索引管理：按维度建 vec0 虚拟表，rowid 映射到 kb_chunks.id
// 失败/不可用时由 kb-chunk.repo 降级为纯 JS 余弦 KNN
import { dbService } from '../database'
import { float32ToBuffer } from './kb-chunk.repo'

const MAP_TABLE = 'kb_vec_map'

function vecTableName(dim: number): string {
  return `kb_vec_${dim}`
}

/** kb_vec_map 由 ensureTable 懒创建（首次 insert/search 时）：全新库从未写过向量时表不存在，
 *  而索引/删除流程会先走清理路径，此处守卫防「no such table」误报为文档索引失败 */
function mapTableExists(): boolean {
  return !!dbService
    .getHandle()
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(MAP_TABLE)
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
    if (!mapTableExists()) return
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
    if (!mapTableExists()) return
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
    if (!mapTableExists()) return
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
   * 返回的 score 是 `1 / (1 + distance)`，只保证「越大越近」；它**不是** JS 路那个余弦分数——
   * 向量都是单位长度时两者才同序（距离² = 2 − 2·cos），未归一化的向量下名次可能不同（见 kb-chunk.repo 的 knnSearch）。
   */
  search(
    query: Float32Array,
    kbIds: string[],
    dim: number,
    topK: number
  ): Array<{ chunkId: string; docId: string; kbId: string; seq: number; content: string; score: number }> {
    if (kbIds.length === 0) return []
    this.ensureTable(dim)
    const db = dbService.getHandle()
    const kbPlaceholders = kbIds.map(() => '?').join(',')

    // vec0 表按「维度」全局共用，不同 KB 但同嵌入模型的块都在同一张表里。
    // 旧写法在全局表上先 `LIMIT topK*3` 取最近邻，再在外层按 kb_id 过滤——大库的近邻
    // 会占满取样名额，小库一条都不返回（且 BM25 对中文常 0 命中 ⇒ 整库像没资料）。
    // sqlite-vec 0.1.9 支持 `embedding MATCH ? AND rowid IN (...)`：先把目标库里
    // 「启用文档」的 rowid 取出来，把过滤压进 KNN 子查询，取样即精确，不再需要超额补偿。
    const rowids = (
      db
        .prepare(
          `SELECT m.vec_rowid AS rowid FROM ${MAP_TABLE} m
           JOIN kb_chunks c ON c.id = m.chunk_id
           WHERE m.dim = ? AND c.kb_id IN (${kbPlaceholders})
             AND c.doc_id NOT IN (SELECT id FROM kb_documents WHERE enabled = 0)`
        )
        .all(dim, ...kbIds) as Array<{ rowid: number }>
    ).map((r) => r.rowid)
    if (rowids.length === 0) return []

    type VecRow = {
      chunk_id: string
      doc_id: string
      kb_id: string
      sequence: number
      content: string
      distance: number
    }
    // sqlite-vec 0.1.9：一旦 KNN 子查询带 rowid IN 约束，就**只认 `k = ?`**，
    // 写 `LIMIT ?` 或字面 `LIMIT n` 都会在 prepare 抛「A LIMIT or 'k = ?' constraint is required」，
    // 并被上层 rag 吞成「向量路 0 命中」（无留痕）。topK 夹逼后走 k = ?。
    const k = Math.max(1, Math.min(1000, Math.floor(topK)))
    const knnBatch = (batch: number[]): VecRow[] => {
      const rowidPlaceholders = batch.map(() => '?').join(',')
      return db
        .prepare(
          // PERF-01：KNN 子查询必须 MATERIALIZED。此前把 vec 虚表放进 JOIN 的 FROM 里，
          // SQLite 不物化它，vec 虚表被放到最内层逐行求值，KNN 实际执行 N 次而非 1 次
          //（20k chunk 实测 27.5 分钟 → 64ms）。两处 `k = ?` 约束保留：sqlite-vec 0.1.9
          // 对 KNN 子查询有「必须带 k = ?」的硬约束（见 :150-152 的历史注释）。
          `WITH v AS MATERIALIZED (
             SELECT rowid, distance FROM ${vecTableName(dim)}
             WHERE embedding MATCH ? AND rowid IN (${rowidPlaceholders}) AND k = ?
             ORDER BY distance ASC
           )
           SELECT c.id AS chunk_id, c.doc_id, c.kb_id, c.sequence, c.content, v.distance
           FROM v
           JOIN ${MAP_TABLE} m ON m.vec_rowid = v.rowid AND m.dim = ?
           JOIN kb_chunks c ON c.id = m.chunk_id
           WHERE c.kb_id IN (${kbPlaceholders})
           ORDER BY v.distance ASC`
        )
        .all(float32ToBuffer(query), ...batch, k, dim, ...kbIds) as VecRow[]
    }
    // SQLite 默认 bind 变量上限 32766；超大库分批各取 topK，再全局归并即可等价。
    const rows: VecRow[] = []
    for (const batch of chunkRowids(rowids)) rows.push(...knnBatch(batch))
    rows.sort((a, b) => a.distance - b.distance)
    return rows.slice(0, topK).map((r) => ({
      chunkId: r.chunk_id,
      docId: r.doc_id,
      kbId: r.kb_id,
      seq: r.sequence,
      content: r.content,
      score: 1 / (1 + r.distance)
    }))
  }
}

/**
 * SQLite 默认 bind 变量上限 32766，留余量按 32000 切片。
 * 抽成纯函数而不是埋在 knn 里：超大库的批次边界可以脱离 sqlite-vec 单独验证（阶段 5）。
 */
export function chunkRowids(rowids: number[], size = 32000): number[][] {
  if (!Number.isInteger(size) || size <= 0) throw new Error('batch size must be a positive integer')
  const out: number[][] = []
  for (let i = 0; i < rowids.length; i += size) out.push(rowids.slice(i, i + size))
  return out
}
