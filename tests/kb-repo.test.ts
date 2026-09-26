// kb.repo 行映射测试
//
// 覆盖 src/main/db/repositories/kb.repo.ts 的 rowToRecord：
// DB 行 → KnowledgeBase 映射（description null 兜底、embedding 字段透传、
// documentCount/chunkCount 从关联表计数查询获取）。
//
// 策略：mock dbService 的 prepare().get() 链返回可控计数；mock mustGet。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { counts } = vi.hoisted(() => ({
  counts: { current: { doc_count: 0, chunk_count: 0 } }
}))
vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: () => ({ get: () => counts.current })
    })
  }
}))
vi.mock('../src/main/db/must-get', () => ({ mustGet: () => null }))

import { rowToRecord } from '../src/main/db/repositories/kb.repo'

beforeEach(() => {
  counts.current = { doc_count: 0, chunk_count: 0 }
})

const baseRow = {
  id: 'kb1',
  name: '我的知识库',
  description: '用于测试',
  embedding_provider_id: 'openai',
  embedding_model: 'text-embedding-3-small',
  embedding_dim: 1536,
  chunk_size: 800,
  chunk_overlap: 200,
  top_k: 20,
  top_n: 5,
  rerank_provider_id: null,
  rerank_model: null,
  hyde_provider_id: null,
  hyde_model: null,
  created_at: 100
}

describe('rowToRecord — DB 行映射为 KnowledgeBase', () => {
  it('基础字段原样透传', () => {
    const kb = rowToRecord(baseRow)
    expect(kb.id).toBe('kb1')
    expect(kb.name).toBe('我的知识库')
    expect(kb.chunkSize).toBe(800)
    expect(kb.chunkOverlap).toBe(200)
    expect(kb.topK).toBe(20)
    expect(kb.topN).toBe(5)
    expect(kb.createdAt).toBe(100)
  })

  it('description=null → 空串兜底', () => {
    expect(rowToRecord({ ...baseRow, description: null }).description).toBe('')
  })

  it('description=非空 → 原样透传', () => {
    expect(rowToRecord(baseRow).description).toBe('用于测试')
  })

  it('embedding 字段 null → 透传 null', () => {
    const kb = rowToRecord({
      ...baseRow,
      embedding_provider_id: null,
      embedding_model: null,
      embedding_dim: null
    })
    expect(kb.embeddingProviderId).toBeNull()
    expect(kb.embeddingModel).toBeNull()
    expect(kb.embeddingDim).toBeNull()
  })

  it('embedding 字段非空 → 原样透传', () => {
    const kb = rowToRecord(baseRow)
    expect(kb.embeddingProviderId).toBe('openai')
    expect(kb.embeddingModel).toBe('text-embedding-3-small')
    expect(kb.embeddingDim).toBe(1536)
  })

  it('documentCount/chunkCount 来自计数查询', () => {
    counts.current = { doc_count: 3, chunk_count: 42 }
    const kb = rowToRecord(baseRow)
    expect(kb.documentCount).toBe(3)
    expect(kb.chunkCount).toBe(42)
  })

  it('计数为 0 时 → documentCount/chunkCount 均为 0', () => {
    counts.current = { doc_count: 0, chunk_count: 0 }
    const kb = rowToRecord(baseRow)
    expect(kb.documentCount).toBe(0)
    expect(kb.chunkCount).toBe(0)
  })
})
