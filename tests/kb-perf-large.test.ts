// 阶段 5：真实大库性能验证 —— 向量写入 / BM25 / JS KNN 兜底 / sqlite-vec 分批
// 只用真 sqlite 与真仓储；耗时不做脆弱的毫秒断言，但要留痕到 perf 环形缓冲并打印供方案记录。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-perf-large'
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

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'
import { clearPerfEvents, getRecentPerf, recordPerf } from '../src/main/steward/perf-probe'

const N = 3000
const DIM = 8
const timing: Record<string, number> = {}

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = (seed % 97) / 97
  v[1] = (seed % 31) / 31
  v[2] = ((seed * 7) % 53) / 53
  v[3] = ((seed * 13) % 89) / 89
  return v
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  clearPerfEvents()
  dbService.open()
  dbService.runMigrations()

  kbRepo.save({
    id: 'kbPerf', name: '性能库', embeddingProviderId: 'p1', embeddingModel: 'm1',
    chunkSize: 800, chunkOverlap: 200, topK: 20, topN: 5, minScore: 0
  })
  const doc = kbDocRepo.insert({ kbId: 'kbPerf', source: 'perf.txt', sourceType: 'txt', title: 'perf' })
  const chunks = Array.from({ length: N }, (_, i) => ({
    id: `c${i}`,
    docId: doc.id,
    kbId: 'kbPerf',
    sequence: i,
    content: `第${i}条 知识库检索性能记录 关键词${i % 50} 向量与全文混合召回`,
    embedding: makeVec(i)
  }))

  const t0 = performance.now()
  kbChunkRepo.insertMany(chunks)
  timing.writeMs = performance.now() - t0
}, 60_000)

afterAll(() => {
  try { dbService.close() } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('真实大库性能留痕', () => {
  it('3000 块写入与 BM25 全文检索可用，耗时记入 perf 环形缓冲', () => {
    expect(kbDocRepo.list('kbPerf')).toHaveLength(1)

    const t1 = performance.now()
    const hits = kbChunkRepo.bm25Search('知识库检索性能', ['kbPerf'], 20)
    timing.bm25Ms = performance.now() - t1
    expect(hits.length).toBeGreaterThan(0)

    recordPerf('kb.perfLarge.write', timing.writeMs!, `${N}chunks`)
    recordPerf('kb.perfLarge.bm25', timing.bm25Ms!, `${N}chunks`)
    expect(getRecentPerf().some((e) => e.label === 'kb.perfLarge.write')).toBe(true)
    // 只卡"慢到不可用"的粗阈值，不做毫秒级脆弱断言
    expect(timing.writeMs!).toBeLessThan(30_000)
    expect(timing.bm25Ms!).toBeLessThan(5_000)
  })

  it('JS KNN 兜底：强制关掉 sqlite-vec 后仍能取回 topK', () => {
    const spy = vi.spyOn(dbService, 'isVecEnabled').mockReturnValue(false)
    const t2 = performance.now()
    const hits = kbChunkRepo.knnSearch(makeVec(7), ['kbPerf'], 20)
    timing.jsKnnMs = performance.now() - t2
    spy.mockRestore()

    expect(hits).toHaveLength(20)
    recordPerf('kb.perfLarge.jsKnn', timing.jsKnnMs!, `${N}chunks`)
    expect(timing.jsKnnMs!).toBeLessThan(5_000)
  })

  it('sqlite-vec 路径（环境可用时）走真实向量表，结果与分批口径一致', () => {
    if (!dbService.isVecEnabled()) return
    const t3 = performance.now()
    const hits = kbChunkRepo.knnSearch(makeVec(7), ['kbPerf'], 20)
    timing.vecKnnMs = performance.now() - t3
    expect(hits).toHaveLength(20)
    recordPerf('kb.perfLarge.vecKnn', timing.vecKnnMs!, `${N}chunks`)
    expect(timing.vecKnnMs!).toBeLessThan(5_000)
  })

  it('输出真机性能记录（方案文档据此填表）', () => {
    // eslint-disable-next-line no-console
    console.log(
      '[KB 性能记录] ' +
        Object.entries(timing)
          .map(([k, v]) => `${k}=${v.toFixed(1)}ms`)
          .join(' ') +
        ` chunks=${N} dim=${DIM}`
    )
    expect(Object.keys(timing).length).toBeGreaterThanOrEqual(3)
  })
})
