// 相似度阈值（增强 B4）真库往返：migration v47 的列 + 每库各用自己的阈值 + 真余弦计算
//
// 为什么用真库而不是 mock：这条特性的全部风险都在「分数从哪来」上——
// 融合分（RRF，0.01~0.03 量级）与 rerank 分（0~1）不可比，所以阈值只能按余弦相似度判。
// 把 knnSearch / loadEmbeddingsByIds / cosineSimilarity 全桩掉，就等于用桩证明桩是对的。
// 这里除 `embedQuery`（要远程 API）外一律真实：临时 SQLite、真表、真向量、真 SQL。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-minscore'
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

/** 查询向量的替身：真 embedQuery 要打远程 embedding API，这里只替这一步 */
const H = vi.hoisted(() => ({ queryVec: new Float32Array([1, 0, 0]) }))

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => H.queryVec,
  embedTexts: async () => []
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo, float32ToBuffer } from '../src/main/db/repositories/kb-chunk.repo'
import { ragService } from '../src/main/knowledge/rag'

const v = (x: number, y: number, z: number) => new Float32Array([x, y, z])

function makeKb(id: string, minScore: number): void {
  kbRepo.save({
    id,
    name: id,
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 10,
    topN: 5,
    minScore
  })
  const doc = kbDocRepo.insert({ kbId: id, source: 'doc.txt', sourceType: 'txt', title: `${id} 文档` })
  kbChunkRepo.insertMany([
    { id: `${id}-par`, docId: doc.id, kbId: id, sequence: 0, content: '与问题同一方向的段落', embedding: v(1, 0, 0) },
    { id: `${id}-orth`, docId: doc.id, kbId: id, sequence: 1, content: '与问题正交的段落', embedding: v(0, 1, 0) }
  ])
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  makeKb('kbA', 0.5)
  makeKb('kbB', 0)
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
  H.queryVec = new Float32Array([1, 0, 0])
})

describe('migration v47 与 kbRepo 的 min_score 往返', () => {
  it('列存在、类型 REAL、默认 0（不过滤）——旧库升级后行为不变', () => {
    const cols = dbService
      .getHandle()
      .prepare(`PRAGMA table_info(knowledge_bases)`)
      .all() as Array<{ name: string; type: string; dflt_value: string | number | null }>
    const col = cols.find((c) => c.name === 'min_score')
    expect(col?.type).toBe('REAL')
    // PRAGMA 把默认值原样以文本给出（'0'），不是数字
    expect(String(col?.dflt_value)).toBe('0')
    // 不再断言 LATEST_SCHEMA_VERSION == 47：那条"最新编号"的断言每加一次迁移就要改两个测试，
    // 而真正要守的是"这一列存在且默认不过滤"，上面的 PRAGMA 已经守住。
  })

  it('save 写入后 get 取回同一个值；0 不被「?? 回退」吞掉', () => {
    expect(kbRepo.get('kbA')?.minScore).toBe(0.5)
    // 只改名字不带 minScore ⇒ 保留原值
    kbRepo.save({ id: 'kbA', name: 'kbA 改名' })
    expect(kbRepo.get('kbA')?.minScore).toBe(0.5)
    // 显式设回 0（=关掉过滤）必须真的写进 0
    kbRepo.save({ id: 'kbA', name: 'kbA 改名', minScore: 0 })
    expect(kbRepo.get('kbA')?.minScore).toBe(0)
    kbRepo.save({ id: 'kbA', name: 'kbA 改名', minScore: 0.5 })
  })
})

describe('检索时按「每库自己的阈值」过滤', () => {
  it('阈值 0.5：与查询向量同向的留下、正交的滤掉，诊断报出滤掉几条', async () => {
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbA'], '退款政策')
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['kbA-par'])
    expect(diagnostics.filteredByThreshold).toBe(1)
    expect(diagnostics.degradations).toEqual([])
  })

  it('反向对照：阈值 0 的库一条都不滤（旧行为一字不变）', async () => {
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbB'], '退款政策')
    expect(result.chunks.map((c) => c.chunkId).sort()).toEqual(['kbB-orth', 'kbB-par'])
    expect(diagnostics.filteredByThreshold).toBe(0)
  })

  it('多库各用自己的阈值：kbA 的无关片段被滤，kbB 的原样保留', async () => {
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '退款政策')
    expect(result.chunks.map((c) => c.chunkId).sort()).toEqual(['kbA-par', 'kbB-orth', 'kbB-par'])
    expect(diagnostics.filteredByThreshold).toBe(1)
  })

  it('阈值高到谁都过不了 ⇒ 诚实返回空（不偷偷回退成不过滤），并数清楚滤掉几条', async () => {
    // 与两条候选都正交的查询向量：相似度全是 0，0.5 的阈值应当把它们全滤掉
    H.queryVec = new Float32Array([0, 0, 1])
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbA'], '退款政策')
    expect(result.chunks).toEqual([])
    expect(diagnostics.filteredByThreshold).toBe(2)
  })

  it('查询向量换了 ⇒ 留下的就是与新向量同向的那条（阈值不是按名次糊的）', async () => {
    H.queryVec = new Float32Array([0, 1, 0])
    const { result } = await ragService.retrieveWithDiagnostics(['kbA'], '另一个问题')
    expect(result.chunks.map((c) => c.chunkId)).toEqual(['kbA-orth'])
  })

  it('候选没有向量、或向量维度与查询不符 ⇒ 保留，不判它不相关', async () => {
    const doc = kbDocRepo.insert({ kbId: 'kbA', source: 'legacy.txt', sourceType: 'txt', title: '旧数据' })
    // 两条都只能靠全文匹配进来（一条 embedding 为 NULL，一条是旧模型的 2 维向量）
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run('kbA-novec', doc.id, 'kbA', 2, '没有向量的历史旧段落', Date.now())
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('kbA-dim2', doc.id, 'kbA', 3, '二维向量的历史旧段落', float32ToBuffer(new Float32Array([1, 0])), Date.now())

    // 查询文本要 ≥3 个 CJK 字才产得出 trigram 词项（fts-query 的既有口径）
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbA'], '历史旧段落')
    const ids = result.chunks.map((c) => c.chunkId)
    expect(ids).toContain('kbA-novec')
    expect(ids).toContain('kbA-dim2')
    expect(ids).toContain('kbA-par')
    // 同方向的那条留下、正交的那条被滤——阈值只对「算得出相似度」的候选说话
    expect(ids).not.toContain('kbA-orth')
    expect(diagnostics.filteredByThreshold).toBe(1)
  })

  it('库没配 embedding（算不出查询向量）却设了阈值 ⇒ 记一条 threshold 降级并跳过过滤', async () => {
    kbRepo.save({ id: 'kbC', name: 'kbC', minScore: 0.5 })
    const doc = kbDocRepo.insert({ kbId: 'kbC', source: 'c.txt', sourceType: 'txt', title: 'C 文档' })
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run('kbC-1', doc.id, 'kbC', 0, '只有全文的段落', Date.now())

    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbC'], '只有全文的段落')
    expect(diagnostics.degradations.map((d) => d.stage)).toContain('threshold')
    expect(diagnostics.filteredByThreshold).toBe(0)
    expect(diagnostics.bm25Hits).toBeGreaterThan(0)
  })
})
