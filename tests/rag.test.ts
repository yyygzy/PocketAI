// RAG 检索纯函数测试
import { describe, it, expect, vi } from 'vitest'

// mock rag.ts 的所有外部依赖，避免加载 portable/db
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { get: () => undefined } }))
vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({ kbChunkRepo: {} }))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: {} }))
vi.mock('../src/main/knowledge/embedding', () => ({ embedQuery: vi.fn() }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))
vi.mock('../src/main/steward/perf-probe', () => ({ recordPerf: vi.fn(), logPerfDebug: vi.fn() }))

import { rrfFuse, ragService } from '../src/main/knowledge/rag'
import type { RetrievedChunk } from '../src/shared/types'

function chunk(id: string, score = 0): RetrievedChunk {
  return { chunkId: id, docId: `doc-${id}`, kbId: 'kb1', seq: 0, docTitle: '', content: `content-${id}`, score }
}

describe('rrfFuse — RRF 混合重排', () => {
  it('空输入返回空数组', () => {
    expect(rrfFuse([])).toEqual([])
    expect(rrfFuse([[]])).toEqual([])
  })

  it('单路结果按原序返回，分数 = 1/(60+rank)', () => {
    const a = chunk('a')
    const b = chunk('b')
    const result = rrfFuse([[a, b]])
    expect(result.map((c) => c.chunkId)).toEqual(['a', 'b'])
    // rank=1 → 1/61, rank=2 → 1/62
    expect(result[0]!.score).toBeCloseTo(1 / 61)
    expect(result[1]!.score).toBeCloseTo(1 / 62)
  })

  it('多路结果中重复 chunk 分数累加', () => {
    const a = chunk('a')
    const b = chunk('b')
    // 路1: a(rank1), b(rank2)
    // 路2: b(rank1), a(rank2)
    const result = rrfFuse([[a, b], [b, a]])
    // a = 1/61 + 1/62, b = 1/62 + 1/61 → 分数相同，排序稳定
    const aScore = result.find((c) => c.chunkId === 'a')!.score
    const bScore = result.find((c) => c.chunkId === 'b')!.score
    expect(aScore).toBeCloseTo(1 / 61 + 1 / 62)
    expect(bScore).toBeCloseTo(1 / 61 + 1 / 62)
  })

  it('仅在一路出现的 chunk 排名靠后', () => {
    const a = chunk('a')
    const b = chunk('b')
    const c = chunk('c')
    // 路1: a, b  路2: a, c
    // a 在两路都排第1 → 2/61
    // b 仅路1 rank2 → 1/62
    // c 仅路2 rank2 → 1/62
    const result = rrfFuse([[a, b], [a, c]])
    expect(result[0]!.chunkId).toBe('a') // a 分数最高
    expect(result[0]!.score).toBeCloseTo(2 / 61)
  })

  it('按融合分数降序排列', () => {
    const a = chunk('a')
    const b = chunk('b')
    const c = chunk('c')
    // 路1: a(1), b(2), c(3)
    // 路2: a(1), c(2), b(3)
    // a = 2/61, b = 1/62+1/63, c = 1/63+1/62
    const result = rrfFuse([[a, b, c], [a, c, b]])
    expect(result[0]!.chunkId).toBe('a')
    // b 和 c 分数相同
    const bScore = result.find((x) => x.chunkId === 'b')!.score
    const cScore = result.find((x) => x.chunkId === 'c')!.score
    expect(bScore).toBeCloseTo(cScore)
  })

  it('带 sourceTags 时 chunk.sources 记录命中路（双路命中合并）', () => {
    const a = chunk('a')
    const b = chunk('b')
    const c = chunk('c')
    // 向量路: a, b  BM25路: a, c
    const result = rrfFuse([[a, b], [a, c]], ['vector', 'bm25'])
    const ra = result.find((x) => x.chunkId === 'a')!
    const rb = result.find((x) => x.chunkId === 'b')!
    const rc = result.find((x) => x.chunkId === 'c')!
    expect(ra.sources?.sort()).toEqual(['bm25', 'vector'])
    expect(rb.sources).toEqual(['vector'])
    expect(rc.sources).toEqual(['bm25'])
  })

  it('不传 sourceTags 时 sources 保持原值（向后兼容）', () => {
    const a = chunk('a')
    const result = rrfFuse([[a]])
    expect(result[0]!.sources).toBeUndefined()
  })
})

describe('buildContext — 知识上下文拼装', () => {
  it('空 chunks 返回空串', () => {
    expect(ragService.buildContext([])).toBe('')
  })

  it('头部带编号引用指令，单 chunk 格式为 [序号. 标题]\\n内容', () => {
    const ctx = ragService.buildContext([
      { chunkId: '1', docId: 'd1', kbId: 'kb1', seq: 0, docTitle: '文档A', content: '内容1', score: 0.5 }
    ])
    expect(ctx).toContain('用编号标注来源（如 [1]、[2]）')
    expect(ctx).toContain('不要编造')
    expect(ctx).toContain('[1. 文档A]\n内容1')
  })

  it('多 chunk 用 --- 分隔，编号与顺序一致', () => {
    const ctx = ragService.buildContext([
      { chunkId: '1', docId: 'd1', kbId: 'kb1', seq: 0, docTitle: 'A', content: 'c1', score: 0.5 },
      { chunkId: '2', docId: 'd2', kbId: 'kb1', seq: 1, docTitle: 'B', content: 'c2', score: 0.3 }
    ])
    expect(ctx).toContain('[1. A]\nc1')
    expect(ctx).toContain('[2. B]\nc2')
    expect(ctx).toContain('---')
    expect(ctx.indexOf('[1. A]')).toBeLessThan(ctx.indexOf('[2. B]'))
  })
})

describe('retrieveWithDiagnostics — 诊断模式带回 timings', () => {
  it('空查询/空 KB 仍返回 timings 对象', async () => {
    const res = await ragService.retrieveWithDiagnostics([], 'test')
    expect(res.diagnostics.timings).toBeDefined()
    expect(typeof res.diagnostics.timings!.totalMs).toBe('number')
    expect(typeof res.diagnostics.timings!.searchMs).toBe('number')
    expect(typeof res.diagnostics.timings!.rerankMs).toBe('number')
    expect(typeof res.diagnostics.timings!.mmrMs).toBe('number')
    expect(res.result.chunks).toEqual([])
  })
})
