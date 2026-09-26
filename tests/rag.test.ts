// RAG 检索纯函数测试
import { describe, it, expect, vi } from 'vitest'

// mock rag.ts 的所有外部依赖，避免加载 portable/db
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: {} }))
vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({ kbChunkRepo: {} }))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({ kbDocRepo: {} }))
vi.mock('../src/main/knowledge/embedding', () => ({ embedQuery: vi.fn() }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => null }
}))

import { rrfFuse, ragService } from '../src/main/knowledge/rag'
import type { RetrievedChunk } from '../src/shared/types'

function chunk(id: string, score = 0): RetrievedChunk {
  return { chunkId: id, docId: `doc-${id}`, docTitle: '', content: `content-${id}`, score }
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
})

describe('buildContext — 知识上下文拼装', () => {
  it('空 chunks 返回空串', () => {
    expect(ragService.buildContext([])).toBe('')
  })

  it('单 chunk 格式为 [序号. 标题]\\n内容', () => {
    const ctx = ragService.buildContext([
      { chunkId: '1', docId: 'd1', docTitle: '文档A', content: '内容1', score: 0.5 }
    ])
    expect(ctx).toBe('以下是相关知识库内容：\n\n[1. 文档A]\n内容1')
  })

  it('多 chunk 用 --- 分隔', () => {
    const ctx = ragService.buildContext([
      { chunkId: '1', docId: 'd1', docTitle: 'A', content: 'c1', score: 0.5 },
      { chunkId: '2', docId: 'd2', docTitle: 'B', content: 'c2', score: 0.3 }
    ])
    expect(ctx).toContain('[1. A]\nc1')
    expect(ctx).toContain('[2. B]\nc2')
    expect(ctx).toContain('---')
  })
})
