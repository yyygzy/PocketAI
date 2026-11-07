// 知识库重建索引的数据安全（真库）：解析/嵌入成功后才在单个事务里替换旧分块。
//
// 为什么必须真库：本缺陷的全部风险都在「删旧」与「写新」的时序和事务边界上。
// 把 repo 全桩掉只能证明桩彼此自洽。这里除 embedTexts（要远程 API）外一律真实：
// 临时 SQLite、真表、真 FTS 触发器、真 sqlite-vec 映射、真事务回滚。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-reindex-atomic'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/** embedding 只打桩远程调用；失败开关让「嵌入抛错」可复现 */
const E = vi.hoisted(() => ({
  failNext: null as Error | null,
  dim: 3,
  calls: 0
}))

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => new Float32Array(E.dim).fill(1),
  embedTexts: async (_providerId: string, _model: string, texts: string[]) => {
    E.calls++
    if (E.failNext) throw E.failNext
    return texts.map((t, i) => {
      const v = new Float32Array(E.dim)
      v[0] = (t.length % 7) + 1
      v[1] = i + 1
      v[2] = 1
      return v
    })
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { ingestionService } from '../src/main/knowledge/ingestion'

const db = () => dbService.getHandle()

interface Fixture {
  kbId: string
  docId: string
  source: string
}

let seq = 0

function makeKb(kbId: string): void {
  kbRepo.save({
    id: kbId,
    name: kbId,
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    embeddingDim: E.dim,
    chunkSize: 200,
    chunkOverlap: 40,
    topK: 10,
    topN: 5
  })
}

function setupDoc(tag: string, content: string): Fixture {
  const kbId = `kb-${tag}-${++seq}`
  makeKb(kbId)
  const source = path.join(P.dir, `src-${tag}-${seq}.md`)
  fs.writeFileSync(source, content)
  const doc = kbDocRepo.insert({ kbId, source, sourceType: 'md', title: tag })
  return { kbId, docId: doc.id, source }
}

function chunkIds(docId: string): string[] {
  return (
    db().prepare('SELECT id FROM kb_chunks WHERE doc_id=? ORDER BY sequence').all(docId) as Array<{
      id: string
    }>
  ).map((r) => r.id)
}

function chunkSeqs(docId: string): number[] {
  return (
    db()
      .prepare('SELECT sequence FROM kb_chunks WHERE doc_id=? ORDER BY sequence')
      .all(docId) as Array<{ sequence: number }>
  ).map((r) => r.sequence)
}

/** 每块向量的落库字节（失败路径要求「旧向量」逐字节不变） */
function vectorSnapshot(docId: string): Record<string, string> {
  const rows = db()
    .prepare('SELECT id, embedding FROM kb_chunks WHERE doc_id=? ORDER BY sequence')
    .all(docId) as Array<{ id: string; embedding: Buffer | null }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.id] = r.embedding ? Buffer.from(r.embedding).toString('hex') : 'null'
  return out
}

function mapCount(docId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM kb_vec_map m JOIN kb_chunks c ON c.id=m.chunk_id WHERE c.doc_id=?`
    )
    .get(docId) as { n: number }
  return row.n
}

/** 全库向量行数（map + vec0）：用来断言回滚后没有留下孤儿向量 */
function vecTotals(): { map: number; vec: number } {
  const map = db().prepare('SELECT COUNT(*) AS n FROM kb_vec_map').get() as { n: number }
  const vec = db()
    .prepare(`SELECT COUNT(*) AS n FROM kb_vec_${E.dim}`)
    .get() as { n: number }
  return { map: map.n, vec: vec.n }
}

function docRow(docId: string): { status: string; error: string | null; chunk_count: number; content_hash: string | null } {
  return db()
    .prepare('SELECT status, error, chunk_count, content_hash FROM kb_documents WHERE id=?')
    .get(docId) as { status: string; error: string | null; chunk_count: number; content_hash: string | null }
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  // 向量映射的保留必须真的验证到，不能因本机没加载 sqlite-vec 而静默跳过
  if (!dbService.isVecEnabled()) throw new Error('sqlite-vec 未加载，无法验证向量映射')
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  E.failNext = null
})

describe('重建索引的原子替换', () => {
  it('成功重建：新块替换旧块，chunk_count 与向量映射一致，旧块 id 不再存在', async () => {
    const f = setupDoc('ok', `# 旧\n${'旧内容段落。'.repeat(120)}`)
    const first = await ingestionService.ingestDocument(f.kbId, f.docId)
    expect(first.status).toBe('ready')

    const oldIds = chunkIds(f.docId)
    expect(oldIds.length).toBeGreaterThan(0)
    expect(docRow(f.docId).chunk_count).toBe(oldIds.length)

    fs.writeFileSync(f.source, `# 新\n${'新内容段落。'.repeat(120)}`)
    const second = await ingestionService.ingestDocument(f.kbId, f.docId)
    expect(second.status).toBe('ready')
    expect(second.error).toBeNull()

    const newIds = chunkIds(f.docId)
    expect(newIds.length).toBeGreaterThan(0)
    for (const id of oldIds) {
      expect(
        db().prepare('SELECT 1 FROM kb_chunks WHERE id=?').get(id)
      ).toBeUndefined()
    }
    expect(newIds.every((id) => !oldIds.includes(id))).toBe(true)

    expect(docRow(f.docId).chunk_count).toBe(newIds.length)
    expect(mapCount(f.docId)).toBe(newIds.length)
  })

  it('源文件删除后重建失败：旧块/旧向量/旧 hash 原样保留，状态如实，且可再次重建', async () => {
    const f = setupDoc('missing', `# 文\n${'可检索的旧内容。'.repeat(100)}`)
    await ingestionService.ingestDocument(f.kbId, f.docId)

    const oldIds = chunkIds(f.docId)
    const oldVectors = vectorSnapshot(f.docId)
    const oldHash = docRow(f.docId).content_hash
    const oldMap = mapCount(f.docId)
    expect(oldIds.length).toBeGreaterThan(0)

    fs.rmSync(f.source, { force: true })
    const failed = await ingestionService.ingestDocument(f.kbId, f.docId)

    // 旧索引仍在 ⇒ ready + 明确说明，而不是让人以为数据没了的 error
    expect(failed.status).toBe('ready')
    expect(failed.error).toContain('重建失败，旧索引已保留')
    expect(failed.error).toContain(`（${oldIds.length} 块）`)

    expect(chunkIds(f.docId)).toEqual(oldIds)
    expect(vectorSnapshot(f.docId)).toEqual(oldVectors)
    expect(mapCount(f.docId)).toBe(oldMap)

    const row = docRow(f.docId)
    expect(row.chunk_count).toBe(oldIds.length)
    expect(row.content_hash).toBe(oldHash)

    // 旧索引仍能被重建替换：恢复源文件即可
    fs.writeFileSync(f.source, `# 恢复\n${'恢复后的新内容。'.repeat(100)}`)
    const again = await ingestionService.ingestDocument(f.kbId, f.docId)
    expect(again.status).toBe('ready')
    expect(again.error).toBeNull()
    expect(chunkIds(f.docId).every((id) => !oldIds.includes(id))).toBe(true)
  })

  it('嵌入抛错：旧块与向量映射仍在，ready + 503 说明，之后可再次重建', async () => {
    const f = setupDoc('embed', `# 文\n${'旧索引内容。'.repeat(100)}`)
    await ingestionService.ingestDocument(f.kbId, f.docId)

    const oldIds = chunkIds(f.docId)
    const oldVectors = vectorSnapshot(f.docId)
    const oldMap = mapCount(f.docId)

    E.failNext = new Error('Embedding API 503')
    const failed = await ingestionService.ingestDocument(f.kbId, f.docId)
    E.failNext = null

    expect(failed.status).toBe('ready')
    expect(failed.error).toContain('旧索引已保留')
    expect(failed.error).toContain('503')
    expect(chunkIds(f.docId)).toEqual(oldIds)
    expect(vectorSnapshot(f.docId)).toEqual(oldVectors)
    expect(mapCount(f.docId)).toBe(oldMap)
    expect(docRow(f.docId).chunk_count).toBe(oldIds.length)

    const again = await ingestionService.ingestDocument(f.kbId, f.docId)
    expect(again.status).toBe('ready')
    expect(again.error).toBeNull()
    expect(chunkIds(f.docId).every((id) => !oldIds.includes(id))).toBe(true)
  })

  it('事务回滚：写新块中途失败，旧块完好且无任何脏数据', async () => {
    const f = setupDoc('rollback', `# 旧\n${'回滚前旧内容。'.repeat(100)}`)
    await ingestionService.ingestDocument(f.kbId, f.docId)

    const oldIds = chunkIds(f.docId)
    const oldVectors = vectorSnapshot(f.docId)
    const oldMap = mapCount(f.docId)
    const totalsBefore = vecTotals()

    // 用触发器在新内容首次落块时制造失败：此时事务里可能已经写入了前面若干块
    db().exec(`
      CREATE TRIGGER kb_reindex_fail_inject
      BEFORE INSERT ON kb_chunks
      WHEN new.content LIKE '%ATOMIC_ROLLBACK_MARKER%'
      BEGIN
        SELECT RAISE(ABORT, '注入的写入失败');
      END
    `)
    try {
      fs.writeFileSync(
        f.source,
        `# 新\n${'前面可以正常写入的段落。'.repeat(60)}\nATOMIC_ROLLBACK_MARKER\n${'后面的段落。'.repeat(20)}`
      )
      const failed = await ingestionService.ingestDocument(f.kbId, f.docId)

      expect(failed.status).toBe('ready')
      expect(failed.error).toContain('重建失败，旧索引已保留')
      expect(failed.error).toContain('注入的写入失败')
      expect(chunkIds(f.docId)).toEqual(oldIds)
      expect(vectorSnapshot(f.docId)).toEqual(oldVectors)
      expect(mapCount(f.docId)).toBe(oldMap)
      expect(
        db()
          .prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE content LIKE '%ATOMIC_ROLLBACK_MARKER%'`)
          .get() as { n: number }
      ).toEqual({ n: 0 })
      expect(docRow(f.docId).chunk_count).toBe(oldIds.length)
      // 回滚后不能有孤儿向量（vec0 行或映射行）
      expect(vecTotals()).toEqual(totalsBefore)
    } finally {
      db().exec('DROP TRIGGER IF EXISTS kb_reindex_fail_inject')
    }

    // 触发失败清除后仍可完成重建
    fs.writeFileSync(f.source, `# 再建\n${'干净的新内容。'.repeat(100)}`)
    const again = await ingestionService.ingestDocument(f.kbId, f.docId)
    expect(again.status).toBe('ready')
    expect(again.error).toBeNull()
    expect(chunkIds(f.docId).every((id) => !oldIds.includes(id))).toBe(true)
  })

  it('同文档并发/重复重建：最终只有一份分块，序号不重复', async () => {
    const f = setupDoc('concurrent', `# 文\n${'并发重建内容。'.repeat(100)}`)
    await ingestionService.ingestDocument(f.kbId, f.docId)

    const [a, b] = await Promise.all([
      ingestionService.ingestDocument(f.kbId, f.docId),
      ingestionService.ingestDocument(f.kbId, f.docId)
    ])
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')

    const ids = chunkIds(f.docId)
    const seqs = chunkSeqs(f.docId)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual(Array.from({ length: ids.length }, (_, i) => i))
    expect(docRow(f.docId).chunk_count).toBe(ids.length)
    expect(mapCount(f.docId)).toBe(ids.length)
  })

  it('文本重建失败：旧原文与旧分块一起保留，不产生半更新', async () => {
    const kbId = `kb-text-${++seq}`
    makeKb(kbId)
    const doc = kbDocRepo.insert({ kbId, source: '手工文本', sourceType: 'txt', title: '手工文本' })
    await ingestionService.ingestText(kbId, doc.id, `${'旧文本内容。'.repeat(100)}`, '手工文本')

    const oldIds = chunkIds(doc.id)
    const oldRaw = kbDocRepo.getRawText(doc.id)
    expect(oldRaw).toContain('旧文本内容')

    E.failNext = new Error('Embedding API 503')
    const failed = await ingestionService.ingestText(kbId, doc.id, `${'新文本内容。'.repeat(100)}`, '手工文本')
    E.failNext = null

    expect(failed.status).toBe('ready')
    expect(failed.error).toContain('旧索引已保留')
    expect(chunkIds(doc.id)).toEqual(oldIds)
    expect(kbDocRepo.getRawText(doc.id)).toBe(oldRaw)
    expect(docRow(doc.id).chunk_count).toBe(oldIds.length)
  })
})
