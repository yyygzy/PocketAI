// 每库的 topK/topN 必须真的传到检索层（V4-Iter-122 A1）
//
// 为什么要这条：设置页每个库都能填「召回深度 topK / 注入条数 topN」（KnowledgeModule.tsx:499-511），
// 但 `rag.ts` 只读 `opts.topK ?? 20`，而四个调用点（chat-service / engine / ask-service / IPC）
// 一个都不传 opts ⇒ 这两个输入框从上线起就是装饰，检索测试面板那句「注入前 N 条」也是假的。
// 本文件不测检索质量（那要真 embedding + 真库），只钉**配置到检索调用的接线**：
// 每次 knnSearch/bm25Search 收到的 limit 必须来自该库自己的配置。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  kbs: {} as Record<string, unknown>,
  knnLimits: [] as number[],
  bm25Limits: [] as number[]
}))

function mkChunks(prefix: string, n: number): unknown[] {
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

vi.mock('../src/main/db/repositories/kb.repo', () => ({
  kbRepo: { get: (id: string) => H.kbs[id] ?? undefined }
}))

vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({
  kbChunkRepo: {
    knnSearch: (_vec: unknown, _ids: string[], limit: number) => {
      H.knnLimits.push(limit)
      return mkChunks('v', limit)
    },
    bm25Search: (_q: string, _ids: string[], limit: number) => {
      H.bm25Limits.push(limit)
      return mkChunks('b', limit)
    },
    loadEmbeddingsByIds: () => new Map()
  }
}))

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: { get: () => ({ title: '某文档' }) }
}))

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => new Float32Array([1, 0])
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

vi.mock('../src/main/steward/perf-probe', () => ({ recordPerf: vi.fn(), logPerfDebug: vi.fn() }))

import { ragService } from '../src/main/knowledge/rag'

const kb = (id: string, topK: number | undefined, topN: number | undefined): unknown => ({
  id,
  name: id,
  embeddingProviderId: 'p1',
  embeddingModel: 'm1',
  chunkSize: 800,
  chunkOverlap: 200,
  topK,
  topN,
  hydeProviderId: null,
  hydeModel: null,
  rerankProviderId: null,
  rerankModel: null,
  multiQueryProviderId: null,
  multiQueryModel: null
})

beforeEach(() => {
  H.kbs = {}
  H.knnLimits = []
  H.bm25Limits = []
})

describe('每库检索配置是否真的接线', () => {
  it('单库：topK=7 / topN=3 ⇒ 两路检索都收到 7，最终只注入 3 条', async () => {
    H.kbs['kb1'] = kb('kb1', 7, 3)
    const { chunks } = await ragService.retrieve(['kb1'], '问题')
    expect(H.knnLimits).toEqual([7])
    expect(H.bm25Limits).toEqual([7])
    expect(chunks).toHaveLength(3)
  })

  it('用户把 topN 调小（3 < 默认 5）⇒ 不许被默认值抬回去', async () => {
    H.kbs['kb1'] = kb('kb1', 9, 2)
    const { chunks } = await ragService.retrieve(['kb1'], '问题')
    expect(chunks).toHaveLength(2)
  })

  it('多库：每库各用自己的 topK 召回，最终注入取各库 topN 的最大值', async () => {
    H.kbs['kbA'] = kb('kbA', 5, 2)
    H.kbs['kbB'] = kb('kbB', 9, 4)
    const { chunks } = await ragService.retrieve(['kbA', 'kbB'], '问题')
    expect(H.knnLimits).toEqual([5, 9])
    expect(H.bm25Limits).toEqual([5, 9])
    expect(chunks).toHaveLength(4)
  })

  it('显式 opts 优先于库配置（检索测试面板要能临时试参数）', async () => {
    H.kbs['kb1'] = kb('kb1', 7, 3)
    const { chunks } = await ragService.retrieve(['kb1'], '问题', { topK: 2, topN: 1 })
    expect(H.knnLimits).toEqual([2])
    expect(H.bm25Limits).toEqual([2])
    expect(chunks).toHaveLength(1)
  })

  it('反向对照：库记录里 topK/topN 是脏值（undefined）⇒ 回落 20/5，而不是 NaN', async () => {
    H.kbs['kb1'] = kb('kb1', undefined, undefined)
    const { chunks } = await ragService.retrieve(['kb1'], '问题')
    expect(H.knnLimits).toEqual([20])
    expect(H.bm25Limits).toEqual([20])
    expect(chunks).toHaveLength(5)
  })

  it('一个库都没解析到 ⇒ 不炸、返回空（兜底常量不参与 max，避免把注入条数抬成默认值）', async () => {
    const { chunks } = await ragService.retrieve(['missing'], '问题')
    expect(H.knnLimits).toEqual([])
    expect(chunks).toEqual([])
  })
})
