// 知识库分块数据访问 + 向量存储（纯 JS 余弦相似度 KNN）
// v1：embedding 以 Float32Array 序列化为 BLOB 存于 kb_chunks.embedding 列
// 后续可平滑切换 sqlite-vec 扩展以支持更大规模检索
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { kbVecRepo } from './kb-vec.repo'
import { buildFtsMatchQuery } from '../../knowledge/fts-query'
import { recordPerf, logPerfDebug } from '../../steward/perf-probe'
import type { KbChunk, RetrievedChunk } from '../../../shared/types'

export interface ChunkInsert {
  id?: string
  docId: string
  kbId: string
  sequence: number
  content: string
  embedding: Float32Array
}

/** 仅正文的分块信息：重建时正文在内存、向量在暂存表，最终事务里两者合并落库 */
export interface StagedChunkContent {
  sequence: number
  content: string
}

/** 单批从暂存表回读的向量条数：把事务内的 JS 堆峰值钉在「一批」而非整篇向量 */
const STAGE_VECTOR_BATCH = 64

/** 暂存表名由本模块生成，只允许这个形状（表名会拼进 SQL，不接受外部传入随意值） */
const STAGE_TABLE_RE = /^kb_stage_[0-9a-f]{32}$/

function assertStageId(stageId: string): void {
  if (!STAGE_TABLE_RE.test(stageId)) throw new Error('非法向量暂存表名')
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

/**
 * JS 兜底 KNN 扫描行数到这个量级就记一条 perf 事件（数据健康面板可见）。
 * 定标依据是实测外推：2 万块（512 维）时旧形状峰值 +51MB / ~150ms，6 万块 +165MB / ~490ms
 * ——真实数据攒够后再复核（同 B27 的口径）。
 */
const JS_KNN_REPORT_ROWS = 5000

/**
 * 有界 top-K 有序插入：只留分数最高的 `cap` 条，`top` 始终按分数降序。
 * 每条最多前移 cap 位 ⇒ 耗时与库大小无关，内存只有 cap 条。
 */
function pushTopK<T extends { score: number }>(top: T[], item: T, cap: number): void {
  if (top.length >= cap && item.score <= top[top.length - 1]!.score) return
  let i = top.length
  top.push(item)
  while (i > 0 && top[i - 1]!.score < item.score) {
    top[i] = top[i - 1]!
    i--
  }
  top[i] = item
  if (top.length > cap) top.pop()
}

/**
 * 纯 JS 余弦 KNN（sqlite-vec 不可用时的兜底路）。
 *
 * 刻意**不**把整表读进数组：512 维一行就是 2KB BLOB，实测旧形状（`.all()` 连正文一起捞）
 * 在 2 万块时让主进程峰值多要 ~51MB、6 万块 ~165MB，而一次检索要按「查询变体数 × 库数」
 * 重复这么多遍（Multi-Query 最多 4 个变体 ⇒ 单库最多 5 遍），卡的正是主进程。
 * 改成游标流式 + 只留 topK 条，峰值与库大小无关；正文等胜出后按 id 回填一次。
 */
function jsCosineKnn(query: Float32Array, kbIds: string[], topK: number): RetrievedChunk[] {
  // 库里存着脏值（topK=0）时不能进 pushTopK——它要比较第 cap 名，cap=0 时根本没有那一条。
  // 旧形状那时返回 slice(0,0)=空，这里保持同样的空结果而不是报错。
  if (topK <= 0) return []
  const db = dbService.getHandle()
  const placeholders = kbIds.map(() => '?').join(',')
  const t0 = performance.now()
  const top: Array<{ chunkId: string; docId: string; kbId: string; seq: number; score: number }> = []
  let scanned = 0
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.kb_id, c.sequence, c.embedding
       FROM kb_chunks c
       WHERE c.kb_id IN (${placeholders}) AND c.embedding IS NOT NULL
         AND c.doc_id NOT IN (SELECT id FROM kb_documents WHERE enabled = 0)`
    )
    .iterate(...kbIds) as IterableIterator<{
      id: string
      doc_id: string
      kb_id: string
      sequence: number
      embedding: Buffer | null
    }>
  try {
    for (const r of rows) {
      scanned++
      const vec = bufferToFloat32(r.embedding)
      // 维度不符（换过 embedding 模型的旧向量）不参与比较，与 vec 路只查同维度表的行为一致
      if (!vec || vec.length !== query.length) continue
      pushTopK(
        top,
        { chunkId: r.id, docId: r.doc_id, kbId: r.kb_id, seq: r.sequence, score: cosineSimilarity(query, vec) },
        topK
      )
    }
  } finally {
    // 迭代没走完（中途抛错）也必须关掉游标，否则语句一直占着连接
    rows.return?.()
  }
  const ms = performance.now() - t0
  const detail = `rows=${scanned} kbs=${kbIds.length} topK=${topK} hits=${top.length}`
  if (scanned >= JS_KNN_REPORT_ROWS) recordPerf('kb.knn.js', ms, detail)
  else logPerfDebug('kb.knn.js', ms, detail)

  if (top.length === 0) return []
  const ids = top.map((t) => t.chunkId)
  const contents = db
    .prepare(`SELECT id, content FROM kb_chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string; content: string }>
  const contentById = new Map(contents.map((c) => [c.id, c.content]))
  return top.map((t) => ({
    chunkId: t.chunkId,
    docId: t.docId,
    kbId: t.kbId,
    seq: t.seq,
    docTitle: '', // 由调用方 join 文档标题
    content: contentById.get(t.chunkId) ?? '',
    score: t.score
  }))
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

  /** 某文档的实际分块数（失败语义按真实块数说话，不信任可能陈旧的 chunk_count） */
  countByDoc(docId: string): number {
    const row = dbService
      .getHandle()
      .prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id=?')
      .get(docId) as { n: number }
    return row.n
  },

  /**
   * 建一张连接级 TEMP 暂存表（不入主库 schema、进程重启即消失）。
   * 重建时 embedding 逐批写这里，而不是把整篇向量堆在 JS 堆里。
   */
  createVectorStage(): string {
    const stageId = `kb_stage_${randomUUID().replace(/-/g, '')}`
    dbService
      .getHandle()
      .exec(`CREATE TEMP TABLE ${stageId} (sequence INTEGER PRIMARY KEY, embedding BLOB NOT NULL)`)
    return stageId
  },

  /** 追加一批向量到暂存表（每批一个短事务，失败只回滚这一批） */
  appendStageVectors(
    stageId: string,
    items: Array<{ sequence: number; embedding: Float32Array }>
  ): void {
    assertStageId(stageId)
    if (items.length === 0) return
    const db = dbService.getHandle()
    const stmt = db.prepare(`INSERT INTO ${stageId}(sequence, embedding) VALUES (?, ?)`)
    const tx = db.transaction((rows: typeof items) => {
      for (const r of rows) stmt.run(r.sequence, float32ToBuffer(r.embedding))
    })
    tx(items)
  },

  /** 丢弃暂存表（成功/失败路径都必须调用；TEMP 表随连接消失，这里主动释放） */
  dropVectorStage(stageId: string): void {
    assertStageId(stageId)
    dbService.getHandle().exec(`DROP TABLE IF EXISTS temp.${stageId}`)
  },

  /**
   * 原子替换某文档的分块与向量：
   * 删旧块（含向量映射）→ 分批从暂存表读回新向量并连同正文写入 → 执行 updateDoc（文档状态/计数等）。
   * 全在**同一个事务**里；任何一步失败整体回滚，旧块与旧向量映射原样保留。
   *
   * 正文 `chunks` 只含文本（已在内存），向量按 STAGE_VECTOR_BATCH 条一批从暂存表取，
   * 事务内的 JS 堆峰值与文档总块数无关。
   */
  replaceDocChunksAtomically(args: {
    docId: string
    kbId: string
    stageId: string
    chunks: StagedChunkContent[]
    updateDoc: () => void
  }): void {
    const { docId, kbId, stageId, chunks, updateDoc } = args
    assertStageId(stageId)
    if (chunks.length === 0) throw new Error('分块后无有效内容')

    const db = dbService.getHandle()
    const contentBySeq = new Map(chunks.map((c) => [c.sequence, c.content]))
    const readStmt = db.prepare(
      `SELECT sequence, embedding FROM ${stageId} WHERE sequence >= ? AND sequence <= ?`
    )
    const tx = db.transaction(() => {
      // 先删向量映射再删块：kbVecRepo.deleteByDoc 依赖 JOIN kb_chunks 找到 rowid
      this.deleteByDoc(docId)
      for (let i = 0; i < chunks.length; i += STAGE_VECTOR_BATCH) {
        const slice = chunks.slice(i, i + STAGE_VECTOR_BATCH)
        const rows = readStmt.all(slice[0]!.sequence, slice[slice.length - 1]!.sequence) as Array<{
          sequence: number
          embedding: Buffer
        }>
        if (rows.length !== slice.length) throw new Error('向量暂存记录不完整，已回滚')
        const inserts: ChunkInsert[] = rows.map((r) => {
          const content = contentBySeq.get(r.sequence)
          const embedding = bufferToFloat32(r.embedding)
          if (content === undefined || !embedding) throw new Error('向量暂存记录损坏，已回滚')
          return { docId, kbId, sequence: r.sequence, content, embedding }
        })
        this.insertMany(inserts)
      }
      updateDoc()
    })
    tx()
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
   * 向量 KNN 检索：sqlite-vec 可用则走原生索引，否则走**有界**的纯 JS 余弦扫描。
   *
   * ⚠️ 两条路的 `score` 不是同一把尺子：vec 路是 `1/(1+欧氏距离)`，JS 路是余弦相似度。
   * 向量是单位长度时两者同序（距离²=2−2·cos），**未归一化的向量下排序可能不同**，
   * 换 embedding 模型或旧数据没重索引时尤其要留意。检索层的相似度阈值与此无关（在 rag 里按余弦另算）。
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
        kbId: h.kbId,
        seq: h.seq,
        docTitle: '',
        content: h.content,
        score: h.score
      }))
    }

    // sqlite-vec 不可用 ⇒ 游标流式的纯 JS 余弦兜底（见 jsCosineKnn 的内存说明）
    return jsCosineKnn(query, kbIds, topK)
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

    // 构造 FTS5 MATCH 查询：CJK 切成 3 字滑窗 OR、拉丁词整词匹配（SEC-18，见 knowledge/fts-query.ts）。
    // 短 CJK 查询产不出词项时直接跳过 BM25（向量路覆盖），不要发一个恒空的 MATCH。
    const matchExpr = buildFtsMatchQuery(query)
    if (!matchExpr) return []

    const placeholders = kbIds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT f.content, f.doc_id, f.kb_id, f.chunk_id, c.sequence, bm25(kb_chunks_fts) AS score
         FROM kb_chunks_fts f
         JOIN kb_chunks c ON c.id = f.chunk_id
         WHERE f.kb_chunks_fts MATCH ? AND f.kb_id IN (${placeholders})
           AND f.doc_id NOT IN (SELECT id FROM kb_documents WHERE enabled = 0)
         ORDER BY score ASC
         LIMIT ?`
      )
      .all(matchExpr, ...kbIds, topK) as Array<{ content: string; doc_id: string; kb_id: string; chunk_id: string; sequence: number; score: number }>

    // FTS5 bm25() 返回值越小越相关，取负数使降序排列时相关的在前
    return rows.map((r) => ({
      chunkId: r.chunk_id,
      docId: r.doc_id,
      kbId: r.kb_id,
      seq: r.sequence,
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
