// 检索降级不再全静默（V4-Iter-125 / 知识库增强 A3）
//
// 为什么必须有这条：向量路、FTS 路、HyDE、Multi-Query、重排、MMR 六处的失败历史上都是
// 空 catch 或「静默退回原序」，于是「少了一路召回」在界面上零痕迹——SEC-18 那次 BM25 恒 0
// 命中就是这么被埋了很久的。本文件钉两件事：
//  ① 每一路失败都要出现在诊断结果里（检索测试面板当场可见），且**不阻断**另一路；
//  ② 每一路失败都要进 perf 环形缓冲（label=kb.degrade）——这条走的是真 perf-probe，
//     不是 mock 自证：数据健康面板「最近慢操作 / 跨会话统计」看的正是这份。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  kbs: {} as Record<string, unknown>,
  embedThrows: false,
  bm25Throws: false,
  hydeResult: null as string | null,
  multiQueryResult: null as string[] | null,
  rerankDegradeReason: null as string | null,
  loadEmbeddingsThrows: false
}))

vi.mock('../src/main/db/repositories/kb.repo', () => ({
  kbRepo: { get: (id: string) => H.kbs[id] ?? undefined }
}))

vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({
  kbChunkRepo: {
    knnSearch: (_vec: unknown, _ids: string[], limit: number) => mkChunks('v', limit),
    bm25Search: (_q: string, _ids: string[], limit: number) => {
      if (H.bm25Throws) throw new Error('no such table: kb_chunks_fts')
      return mkChunks('b', limit)
    },
    loadEmbeddingsByIds: () => {
      if (H.loadEmbeddingsThrows) throw new Error('向量表不可用')
      return new Map()
    }
  }
}))

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: { get: () => ({ title: '某文档' }) }
}))

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => {
    if (H.embedThrows) throw new Error('embedding 服务 502')
    return new Float32Array([1, 0])
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

vi.mock('../src/main/knowledge/hyde', () => ({
  generateHypotheticalDoc: async () => H.hydeResult
}))

vi.mock('../src/main/knowledge/multi-query', () => ({
  generateMultiQueries: async () => H.multiQueryResult,
  MAX_MULTI_QUERIES: 4
}))

// 重排桩：真实 reranker 内部吞异常，这里直接把「降级原因」吐给第 5 个参数（回调是本轮新加的口子）
vi.mock('../src/main/knowledge/reranker', () => ({
  rerankChunks: async (
    _q: string,
    chunks: unknown[],
    _p: string,
    _m: string,
    onDegrade?: (reason: string) => void
  ) => {
    if (H.rerankDegradeReason) onDegrade?.(H.rerankDegradeReason)
    return chunks
  },
  parseRerankScores: () => null
}))

import { ragService } from '../src/main/knowledge/rag'
import { clearPerfEvents, getRecentPerf } from '../src/main/steward/perf-probe'
import type { RetrievalDegradation, RetrievedChunk } from '../src/shared/types'

function mkChunks(prefix: string, n: number): RetrievedChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `${prefix}-${i}`,
    docId: `doc-${prefix}-${i}`,
    kbId: 'kb1',
    seq: i,
    docTitle: '',
    content: `c${i}`,
    score: 0
  }))
}

const kb = (over: Record<string, unknown> = {}): unknown => ({
  id: 'kb1',
  name: 'kb1',
  embeddingProviderId: 'p1',
  embeddingModel: 'm1',
  chunkSize: 800,
  chunkOverlap: 200,
  topK: 5,
  topN: 2,
  hydeProviderId: null,
  hydeModel: null,
  rerankProviderId: null,
  rerankModel: null,
  multiQueryProviderId: null,
  multiQueryModel: null,
  ...over
})

function stages(list: RetrievalDegradation[]): string[] {
  return list.map((d) => d.stage)
}

/** 环形缓冲里本次跑期间产生的 kb.degrade 详情 */
function perfDegradeDetails(): string[] {
  return getRecentPerf()
    .filter((e) => e.label === 'kb.degrade')
    .map((e) => e.detail ?? '')
}

beforeEach(() => {
  H.kbs = { kb1: kb() }
  H.embedThrows = false
  H.bm25Throws = false
  H.hydeResult = null
  H.multiQueryResult = null
  H.rerankDegradeReason = null
  H.loadEmbeddingsThrows = false
  clearPerfEvents()
})

describe('检索降级可观测（A3）', () => {
  it('一切正常 ⇒ degradations 是空的（反向对照：不是无条件往里塞）', async () => {
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(diagnostics.degradations).toEqual([])
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(perfDegradeDetails()).toEqual([])
  })

  it('向量路抛错 ⇒ 诊断记 stage=vector（带 kbId），BM25 那一路照常返回，不阻断', async () => {
    H.embedThrows = true
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual(['vector'])
    expect(diagnostics.degradations[0]?.kbId).toBe('kb1')
    expect(diagnostics.degradations[0]?.reason).toContain('embedding 服务 502')
    expect(diagnostics.vectorHits).toBe(0)
    expect(diagnostics.bm25Hits).toBeGreaterThan(0)
    expect(result.chunks.length).toBeGreaterThan(0)
    // 同一条事实同时进 perf 缓冲：面板与跨会话统计靠它数次数
    expect(perfDegradeDetails()).toEqual(['stage=vector kb=kb1 reason=向量化或向量检索失败：embedding 服务 502'])
  })

  it('FTS 抛错 ⇒ stage=bm25，向量那一路照常（SEC-18 那类问题从此有痕迹）', async () => {
    H.bm25Throws = true
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual(['bm25'])
    expect(diagnostics.degradations[0]?.reason).toContain('no such table: kb_chunks_fts')
    expect(diagnostics.vectorHits).toBeGreaterThan(0)
  })

  it('配了 HyDE 却没拿到假设文档 ⇒ stage=hyde（向量路退回原查询，这是降级不是正常态）', async () => {
    H.kbs = { kb1: kb({ hydeProviderId: 'p1', hydeModel: 'm1' }) }
    H.hydeResult = null
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual(['hyde'])
    expect(diagnostics.hydeUsed).toBe(false)
  })

  it('没配 HyDE ⇒ 不记降级（配置缺失与调用失败不是一回事，别把面板刷脏）', async () => {
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual([])
  })

  it('配了 Multi-Query 却拿不到变体 ⇒ stage=multiQuery', async () => {
    H.kbs = { kb1: kb({ multiQueryProviderId: 'p1', multiQueryModel: 'm1' }) }
    H.multiQueryResult = null
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual(['multiQuery'])
  })

  it('重排降级 ⇒ stage=rerank，原因逐字取自回调（以前与「重排后恰好同序」完全无法区分）', async () => {
    H.kbs = { kb1: kb({ rerankProviderId: 'p1', rerankModel: 'm1' }) }
    H.rerankDegradeReason = '模型输出的评分 JSON 解析不出任何非零分，顺序退回 RRF 融合序'
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toEqual(['rerank'])
    expect(diagnostics.degradations[0]?.reason).toContain('解析不出任何非零分')
  })

  it('MMR 取向量失败 ⇒ stage=mmr，仍然按融合序给出 topN', async () => {
    H.loadEmbeddingsThrows = true
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    expect(stages(diagnostics.degradations)).toContain('mmr')
    expect(result.chunks).toHaveLength(2) // 该库 topN=2
  })

  it('同一库同一路的重复失败只记一条（多查询变体全挂时不该刷出 N 行）', async () => {
    H.embedThrows = true
    H.kbs = { kb1: kb({ multiQueryProviderId: 'p1', multiQueryModel: 'm1' }) }
    H.multiQueryResult = ['变体一', '变体二']
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kb1'], '问题')
    // 原查询 + 2 个变体 = 三次向量检索全失败，只留一条 vector
    expect(diagnostics.queryVariants).toHaveLength(3)
    expect(stages(diagnostics.degradations).filter((s) => s === 'vector')).toHaveLength(1)
    expect(perfDegradeDetails().filter((d) => d.includes('stage=vector'))).toHaveLength(1)
  })
})
