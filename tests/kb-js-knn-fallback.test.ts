// vec 不可用时的纯 JS 兜底 KNN：结果要与 vec 路一致，且不再按库大小物化整表（V4-Iter-134）
//
// 为什么要这条：`knnSearch` 的非 vec 分支历史上是 `SELECT c.id, c.content, c.embedding ... .all()`
// 一次把整库读进数组再排序。本机实测（512 维）：2 万块 ⇒ 主进程峰值 +50.9MB / 152ms，
// 6 万块 ⇒ +164.7MB / 489ms；而一次检索要按「查询变体数(≤5) × 库数」重复这么多遍——
// sqlite-vec 装不上的那台机器上，卡的正是主进程。
// 策略：真临时库、真表、真向量，只把 `dbService.isVecEnabled()` 这一个开关翻下来走兜底路，
// 于是「两条路给出同一组结果」变成可断言的事，而不是拿 mock 证明 mock。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-js-knn'
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
import { clearPerfEvents, getRecentPerf } from '../src/main/steward/perf-probe'
import type { RetrievedChunk } from '../src/shared/types'

const v = (...n: number[]) => new Float32Array(n)
const QUERY = v(1, 0, 0)
const ids = (list: RetrievedChunk[]): string[] => list.map((c) => c.chunkId)

/** 翻 vec 开关（只动这一个点），返回恢复函数 */
function withVec(enabled: boolean): () => void {
  const orig = dbService.isVecEnabled
  dbService.isVecEnabled = () => enabled
  return () => {
    dbService.isVecEnabled = orig
  }
}

function makeKb(id: string): void {
  kbRepo.save({
    id,
    name: id,
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 10,
    topN: 5,
    minScore: 0
  })
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  makeKb('kbA')
  const doc1 = kbDocRepo.insert({ kbId: 'kbA', source: 'a.txt', sourceType: 'txt', title: '启用的文档' })
  const doc2 = kbDocRepo.insert({ kbId: 'kbA', source: 'b.txt', sourceType: 'txt', title: '停用的文档' })
  // 前四条：单位向量，与 QUERY 的余弦分别是 1 / 0.8 / 0.6 / 0.5（互不相同，两条路才可比）
  kbChunkRepo.insertMany([
    { id: 'c-same', docId: doc1.id, kbId: 'kbA', sequence: 0, content: '正文 同向', embedding: v(1, 0, 0) },
    { id: 'c-08', docId: doc1.id, kbId: 'kbA', sequence: 1, content: '正文 0.8', embedding: v(0.8, 0.6, 0) },
    { id: 'c-06', docId: doc1.id, kbId: 'kbA', sequence: 2, content: '正文 0.6', embedding: v(0.6, 0.8, 0) },
    { id: 'c-05', docId: doc1.id, kbId: 'kbA', sequence: 3, content: '正文 0.5', embedding: v(0.5, 0.5, Math.SQRT1_2) },
    // 换过 embedding 模型留下的旧向量（2 维）：两条路都该排除它
    { id: 'c-dim2', docId: doc1.id, kbId: 'kbA', sequence: 4, content: '旧维度', embedding: v(1, 0) },
    // 停用文档里的两条（0 与 -1）：应当整篇排除
    { id: 'c-orth', docId: doc2.id, kbId: 'kbA', sequence: 5, content: '停用文档 A', embedding: v(0, 1, 0) },
    { id: 'c-opp', docId: doc2.id, kbId: 'kbA', sequence: 6, content: '停用文档 B', embedding: v(-1, 0, 0) }
  ])
  kbDocRepo.setEnabled(doc2.id, false)
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('JS 兜底路与 vec 路的结果一致性', () => {
  it('单位向量下两条路给出同一组 topK、同一顺序', () => {
    const vecHits = kbChunkRepo.knnSearch(QUERY, ['kbA'], 4)
    const restore = withVec(false)
    let jsHits: RetrievedChunk[]
    try {
      jsHits = kbChunkRepo.knnSearch(QUERY, ['kbA'], 4)
    } finally {
      restore()
    }
    expect(ids(vecHits)).toEqual(['c-same', 'c-08', 'c-06', 'c-05'])
    expect(ids(jsHits)).toEqual(ids(vecHits))
  })

  it('JS 路的分数就是余弦相似度（vec 路是 1/(1+欧氏距离)，两把尺子不许混）', () => {
    const restore = withVec(false)
    try {
      const hits = kbChunkRepo.knnSearch(QUERY, ['kbA'], 4)
      expect(hits.map((h) => Number(h.score.toFixed(4)))).toEqual([1, 0.8, 0.6, 0.5])
    } finally {
      restore()
    }
  })

  it('停用文档与维度不符的旧向量：两条路都排除', () => {
    const restore = withVec(false)
    let jsIds: string[]
    try {
      jsIds = ids(kbChunkRepo.knnSearch(QUERY, ['kbA'], 50))
    } finally {
      restore()
    }
    expect(jsIds).toEqual(['c-same', 'c-08', 'c-06', 'c-05'])
    expect(ids(kbChunkRepo.knnSearch(QUERY, ['kbA'], 50))).toEqual(jsIds)
  })

  it('topK 大于行数 ⇒ 全给且降序、正文回填到位；库里脏值 topK=0 ⇒ 空结果而不是抛错', () => {
    const restore = withVec(false)
    try {
      const all = kbChunkRepo.knnSearch(QUERY, ['kbA'], 999)
      expect(ids(all)).toEqual(['c-same', 'c-08', 'c-06', 'c-05'])
      expect(all.map((c) => c.content)).toEqual(['正文 同向', '正文 0.8', '正文 0.6', '正文 0.5'])
      expect(kbChunkRepo.knnSearch(QUERY, ['kbA'], 0)).toEqual([])
      expect(kbChunkRepo.knnSearch(QUERY, ['不存在的库'], 3)).toEqual([])
    } finally {
      restore()
    }
  })

  it('随机 50 块 × 8 维：topK=7 与暴力全排序逐条一致（有界插入不许漏选或错序）', () => {
    let s = 20261014
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648 + 0.05
    }
    const q = v(...Array.from({ length: 8 }, rnd))
    const made = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      embedding: v(...Array.from({ length: 8 }, rnd))
    }))
    const doc = kbDocRepo.insert({ kbId: 'kbA', source: 'rnd.txt', sourceType: 'txt', title: '随机块' })
    kbChunkRepo.insertMany(
      made.map((m, i) => ({ id: m.id, docId: doc.id, kbId: 'kbA', sequence: i, content: `正文 ${m.id}`, embedding: m.embedding }))
    )
    const cos = (a: Float32Array, b: Float32Array): number => {
      let dot = 0
      let na = 0
      let nb = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!
        na += a[i]! * a[i]!
        nb += b[i]! * b[i]!
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb))
    }
    const brute = [...made]
      .map((m) => ({ id: m.id, s: cos(q, m.embedding) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 7)
      .map((x) => x.id)

    const restore = withVec(false)
    try {
      // kbA 里其余启用中的块是 3 维/2 维，与这条 8 维查询不同维度 ⇒ 只剩这 50 条可比
      expect(ids(kbChunkRepo.knnSearch(q, ['kbA'], 7))).toEqual(brute)
    } finally {
      restore()
    }
  })
})

describe('兜底路的内存上限与可观测', () => {
  it('流式扫描的 SQL 里不许再出现正文（正文只在胜出后按 id 回填一次）', () => {
    const h = dbService.getHandle()
    const orig = h.prepare.bind(h)
    const sqls: string[] = []
    h.prepare = (sql: string) => {
      sqls.push(sql)
      return orig(sql)
    }
    const restore = withVec(false)
    try {
      kbChunkRepo.knnSearch(QUERY, ['kbA'], 3)
    } finally {
      restore()
      h.prepare = orig
    }
    const scan = sqls.find((sql) => sql.includes('FROM kb_chunks c') && sql.includes('c.embedding'))
    expect(typeof scan).toBe('string')
    expect(scan).not.toContain('content')
    expect(sqls.some((sql) => sql.includes('SELECT id, content FROM kb_chunks WHERE id IN'))).toBe(true)
  })

  it('扫描行数够多才记一条 kb.knn.js 事件，小库不记（数据健康据此判断该不该上 vec）', () => {
    makeKb('kbBig')
    const doc = kbDocRepo.insert({ kbId: 'kbBig', source: 'big.txt', sourceType: 'txt', title: '大库文档' })
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: `big-${i}`,
      docId: doc.id,
      kbId: 'kbBig',
      sequence: i,
      content: `正文 ${i}`,
      embedding: v(i % 7 === 0 ? 1 : 0, 1, 0)
    }))
    clearPerfEvents()
    const restore = withVec(false)
    try {
      // 关着 vec 写入：这 5000 条只进主表，省掉向量索引的写入开销
      kbChunkRepo.insertMany(rows)
      // 反向对照：四条的小库不该产生事件
      kbChunkRepo.knnSearch(QUERY, ['kbA'], 3)
      expect(getRecentPerf().filter((e) => e.label === 'kb.knn.js')).toEqual([])

      kbChunkRepo.knnSearch(QUERY, ['kbBig'], 3)
      const evts = getRecentPerf().filter((e) => e.label === 'kb.knn.js')
      expect(evts).toHaveLength(1)
      expect(evts[0]?.detail).toContain('rows=5000 kbs=1 topK=3 hits=3')
    } finally {
      restore()
      clearPerfEvents()
    }
  })
})
