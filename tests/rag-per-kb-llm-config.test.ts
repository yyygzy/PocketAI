// 多库检索时，每库自己的 HyDE / Multi-Query / 重排配置必须按库生效（V4-Iter-133）
//
// 为什么要这条：设置页每个库都能选自己的 HyDE / Multi-Query / 重排模型
// （KnowledgeModule.tsx:319-419 三组下拉框），但 `rag.ts` 取的是「第一个配了的库」的配置给全部库用：
//  · 排在后面的库配了等于没配（和 V4-Iter-122 的 topK 同一类没接线）；
//  · 反过来，**没配**的库会被别的库的配置污染——假设文档被拿去喂它的 embedding、
//    别人的查询变体挤进它的召回，注入质量被一个它没点过的模型改掉了。
// 本文件只钉「调用参数按库走 + 同一套配置不多打一次 LLM」，不测检索质量（那要真模型，见 V4-Iter-130）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  kbs: {} as Record<string, unknown>,
  /** key = `providerId|model` → 该配置返回的假设文档（null=调用失败/解析为空） */
  hydeResults: {} as Record<string, string | null>,
  mqResults: {} as Record<string, string[] | null>,
  hydeCalls: [] as string[],
  mqCalls: [] as string[],
  embedTexts: [] as string[],
  bm25Calls: [] as Array<{ q: string; kbId: string }>,
  rerankCalls: [] as Array<{ key: string; chunkIds: string[] }>,
  rerankFails: false
}))

vi.mock('../src/main/db/repositories/kb.repo', () => ({
  kbRepo: { get: (id: string) => H.kbs[id] ?? undefined }
}))

vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({
  kbChunkRepo: {
    knnSearch: (_vec: unknown, kbIds: string[], limit: number) => mkChunks(kbIds[0] ?? '?', 'v', limit),
    bm25Search: (q: string, kbIds: string[], limit: number) => {
      H.bm25Calls.push({ q, kbId: kbIds[0] ?? '?' })
      return mkChunks(kbIds[0] ?? '?', 'b', limit)
    },
    loadEmbeddingsByIds: () => new Map()
  }
}))

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: { get: () => ({ title: '某文档' }) }
}))

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async (_p: string, _m: string, text: string) => {
    H.embedTexts.push(text)
    return new Float32Array([1, 0])
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

vi.mock('../src/main/knowledge/hyde', () => ({
  generateHypotheticalDoc: async (_q: string, providerId: string, model: string) => {
    const key = `${providerId}|${model}`
    H.hydeCalls.push(key)
    return H.hydeResults[key] ?? null
  }
}))

vi.mock('../src/main/knowledge/multi-query', () => ({
  generateMultiQueries: async (_q: string, providerId: string, model: string) => {
    const key = `${providerId}|${model}`
    H.mqCalls.push(key)
    return H.mqResults[key] ?? null
  },
  MAX_MULTI_QUERIES: 4
}))

// 重排桩：模拟真实 reranker 的两件事——按分排序后返回、并打上 0~1 的重排分（组内倒序最容易看出串味）
vi.mock('../src/main/knowledge/reranker', () => ({
  rerankChunks: async (
    _q: string,
    chunks: Array<{ chunkId: string; score: number }>,
    providerId: string,
    model: string,
    onDegrade?: (reason: string) => void
  ) => {
    H.rerankCalls.push({ key: `${providerId}|${model}`, chunkIds: chunks.map((c) => c.chunkId) })
    if (H.rerankFails) onDegrade?.('模型输出的评分 JSON 解析不出任何非零分，顺序退回 RRF 融合序')
    return [...chunks].reverse().map((c, i) => ({ ...c, score: 0.9 - i * 0.3 }))
  },
  parseRerankScores: () => null
}))

import { ragService } from '../src/main/knowledge/rag'
import type { RetrievedChunk } from '../src/shared/types'

function mkChunks(kbId: string, kind: string, n: number): RetrievedChunk[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `${kbId}-${kind}-${i}`,
    docId: `doc-${kbId}-${kind}-${i}`,
    kbId,
    seq: i,
    docTitle: '',
    content: `c${i}`,
    score: 0
  }))
}

const kb = (id: string, over: Record<string, unknown> = {}): unknown => ({
  id,
  name: id,
  embeddingProviderId: 'p-emb',
  embeddingModel: 'm-emb',
  chunkSize: 800,
  chunkOverlap: 200,
  topK: 2,
  topN: 2,
  minScore: 0,
  hydeProviderId: null,
  hydeModel: null,
  rerankProviderId: null,
  rerankModel: null,
  multiQueryProviderId: null,
  multiQueryModel: null,
  ...over
})

beforeEach(() => {
  H.kbs = {}
  H.hydeResults = {}
  H.mqResults = {}
  H.hydeCalls = []
  H.mqCalls = []
  H.embedTexts = []
  H.bm25Calls = []
  H.rerankCalls = []
  H.rerankFails = false
})

describe('每库的 HyDE 配置按库生效', () => {
  it('没配 HyDE 的库不许被别的库的假设文档污染（向量路各喂各的文本）', async () => {
    H.hydeResults['p1|m1'] = '假设文档A'
    H.kbs = {
      kbA: kb('kbA', { hydeProviderId: 'p1', hydeModel: 'm1' }),
      kbB: kb('kbB')
    }
    await ragService.retrieve(['kbA', 'kbB'], '问题')
    // kbA 用假设文档做 embedding，kbB 必须还是原查询
    expect(H.embedTexts).toEqual(['假设文档A', '问题'])
  })

  it('三个库共用同一套 HyDE 配置 ⇒ 只调一次 LLM（缓存不许按库数放大）', async () => {
    H.hydeResults['p1|m1'] = '共享假设文档'
    H.kbs = {
      kbA: kb('kbA', { hydeProviderId: 'p1', hydeModel: 'm1' }),
      kbB: kb('kbB', { hydeProviderId: 'p1', hydeModel: 'm1' }),
      kbC: kb('kbC', { hydeProviderId: 'p1', hydeModel: 'm1' })
    }
    await ragService.retrieve(['kbA', 'kbB', 'kbC'], '问题')
    expect(H.hydeCalls).toEqual(['p1|m1'])
    expect(H.embedTexts).toEqual(['共享假设文档', '共享假设文档', '共享假设文档'])
  })

  it('两个库各配一套 HyDE ⇒ 两个库都真的跑，不是「第一个赢」', async () => {
    H.hydeResults['p1|m1'] = '文档甲'
    H.hydeResults['p2|m2'] = '文档乙'
    H.kbs = {
      kbA: kb('kbA', { hydeProviderId: 'p1', hydeModel: 'm1' }),
      kbB: kb('kbB', { hydeProviderId: 'p2', hydeModel: 'm2' })
    }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(H.hydeCalls).toEqual(['p1|m1', 'p2|m2'])
    expect(H.embedTexts).toEqual(['文档甲', '文档乙'])
    expect(diagnostics.hydeUsed).toBe(true)
  })

  it('配了 HyDE 却没拿到文档 ⇒ 降级按库留痕（kbId 不再是缺省）', async () => {
    H.kbs = {
      kbA: kb('kbA', { hydeProviderId: 'p1', hydeModel: 'm1' }),
      kbB: kb('kbB', { hydeProviderId: 'p2', hydeModel: 'm2' })
    }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(diagnostics.degradations.map((d) => `${d.stage}:${d.kbId ?? '-'}`)).toEqual(['hyde:kbA', 'hyde:kbB'])
    expect(diagnostics.hydeUsed).toBe(false)
  })
})

describe('每库的 Multi-Query 配置按库生效', () => {
  it('没配 Multi-Query 的库不被塞进别人的查询变体', async () => {
    H.mqResults['p1|m1'] = ['变体一', '变体二']
    H.kbs = {
      kbA: kb('kbA', { multiQueryProviderId: 'p1', multiQueryModel: 'm1' }),
      kbB: kb('kbB')
    }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(H.bm25Calls.filter((c) => c.kbId === 'kbA').map((c) => c.q)).toEqual(['问题', '变体一', '变体二'])
    expect(H.bm25Calls.filter((c) => c.kbId === 'kbB').map((c) => c.q)).toEqual(['问题'])
    // 面板列的是本次实际用过的查询（并集），不是某个库的清单
    expect(diagnostics.queryVariants).toEqual(['问题', '变体一', '变体二'])
  })

  it('同配置两库只调一次；不同配置各自都调', async () => {
    H.mqResults['p1|m1'] = ['变体一']
    H.mqResults['p2|m2'] = ['变体二']
    H.kbs = {
      kbA: kb('kbA', { multiQueryProviderId: 'p1', multiQueryModel: 'm1' }),
      kbB: kb('kbB', { multiQueryProviderId: 'p1', multiQueryModel: 'm1' }),
      kbC: kb('kbC', { multiQueryProviderId: 'p2', multiQueryModel: 'm2' })
    }
    await ragService.retrieve(['kbA', 'kbB', 'kbC'], '问题')
    expect(H.mqCalls).toEqual(['p1|m1', 'p2|m2'])
  })

  it('配了 Multi-Query 却没有变体 ⇒ 按库各记一条降级', async () => {
    H.kbs = { kbA: kb('kbA', { multiQueryProviderId: 'p1', multiQueryModel: 'm1' }) }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA'], '问题')
    expect(diagnostics.degradations.map((d) => `${d.stage}:${d.kbId ?? '-'}`)).toEqual(['multiQuery:kbA'])
  })
})

describe('每库的重排配置按库生效', () => {
  it('只有配了重排的库参与重排，且用的是它自己的那套模型', async () => {
    // topK=4 让两库的候选都在候选表里，否则 kbB 早被 maxTopK 挤掉，这条就白测了
    H.kbs = {
      kbA: kb('kbA', { topK: 4, topN: 4, rerankProviderId: 'p1', rerankModel: 'm1' }),
      kbB: kb('kbB', { topK: 4, topN: 4 })
    }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(diagnostics.candidateCount).toBe(4)
    expect(H.rerankCalls).toHaveLength(1)
    expect(H.rerankCalls[0]?.key).toBe('p1|m1')
    expect(H.rerankCalls[0]?.chunkIds).toEqual(['kbA-v-0', 'kbA-b-0'])
    expect(diagnostics.rerankUsed).toBe(true)
  })

  it('两库共用同一套重排配置 ⇒ 一次调用覆盖两库候选', async () => {
    // topK 取 4：候选窗口是「各库 topK 的最大值」，两库各 2 时前四名会被 kbA 占满（既有口径，见台账）
    H.kbs = {
      kbA: kb('kbA', { topK: 4, topN: 4, rerankProviderId: 'p1', rerankModel: 'm1' }),
      kbB: kb('kbB', { topK: 4, topN: 4, rerankProviderId: 'p1', rerankModel: 'm1' })
    }
    const { chunks } = await ragService.retrieve(['kbA', 'kbB'], '问题')
    expect(H.rerankCalls).toHaveLength(1)
    expect(H.rerankCalls[0]?.chunkIds).toEqual(['kbA-v-0', 'kbA-b-0', 'kbB-v-0', 'kbB-b-0'])
    expect(chunks).toHaveLength(4)
  })

  it('一个库都没配重排 ⇒ 一次都不调，顺序就是融合序', async () => {
    H.kbs = { kbA: kb('kbA'), kbB: kb('kbB') }
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(H.rerankCalls).toEqual([])
    expect(diagnostics.rerankUsed).toBe(false)
  })

  it('组内重排只改组内顺序：跨库排序仍按融合分，重排分不许跨组比', async () => {
    // topK=4 让两库候选都进入重排前的候选表；融合分前四名全并列 1/61
    H.kbs = {
      kbA: kb('kbA', { topK: 4, topN: 4, rerankProviderId: 'p1', rerankModel: 'm1' }),
      kbB: kb('kbB', { topK: 4, topN: 4 })
    }
    const { chunks } = await ragService.retrieve(['kbA', 'kbB'], '问题')
    // 桩是「组内倒序」：kbA 的两条换序，kbB 的两条一条也不动
    expect(chunks.map((c) => c.chunkId).slice(0, 2)).toEqual(['kbA-b-0', 'kbA-v-0'])
    expect(chunks.map((c) => c.chunkId).slice(2)).toEqual(['kbB-v-0', 'kbB-b-0'])
    // 且注入条目的分数仍是融合分量级，没被 0~1 的重排分顶掉
    expect(chunks.every((c) => c.score > 0 && c.score < 0.05)).toBe(true)
  })

  it('重排降级 ⇒ stage=rerank 并带上是哪几个库', async () => {
    H.kbs = {
      kbA: kb('kbA', { rerankProviderId: 'p1', rerankModel: 'm1' }),
      kbB: kb('kbB', { rerankProviderId: 'p1', rerankModel: 'm1' })
    }
    H.rerankFails = true
    const { diagnostics } = await ragService.retrieveWithDiagnostics(['kbA', 'kbB'], '问题')
    expect(diagnostics.degradations.map((d) => `${d.stage}:${d.kbId ?? '-'}`)).toEqual(['rerank:kbA+kbB'])
    expect(diagnostics.degradations[0]?.reason).toContain('解析不出任何非零分')
  })
})
