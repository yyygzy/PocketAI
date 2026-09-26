// 入库流水线编排测试：解析 → 分块 → 向量化 → 状态推进 → 存储，以及异常路径
// 通过 mock 三个 repo 与 embedding 模块（真实 chunker + 真实 parser 跑临时文件），
// 验证 IngestionService 的状态机、重新索引清理、错误不抛出而落库等关键行为。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KnowledgeBase, KbDocument } from '../src/shared/types'

// mock 共享状态（必须用 vi.hoisted，工厂不能引用普通顶层变量）
const mocks = vi.hoisted(() => ({
  kb: null as KnowledgeBase | null,
  doc: null as (KbDocument & { status: string; error: string | null }) | null,
  statuses: [] as string[],
  errors: [] as (string | null)[],
  deletedByDoc: [] as string[],
  inserted: [] as Array<{ docId: string; kbId: string; sequence: number; content: string; embedding: Float32Array }>,
  dimSet: [] as Array<{ id: string; dim: number }>,
  chunkCounts: [] as Array<{ id: string; n: number }>,
  embedCalls: [] as number[],
  embedError: null as Error | null,
  reset() {
    this.kb = null
    this.doc = null
    this.statuses = []
    this.errors = []
    this.deletedByDoc = []
    this.inserted = []
    this.dimSet = []
    this.chunkCounts = []
    this.embedCalls = []
    this.embedError = null
  }
}))

vi.mock('../src/main/db/repositories/kb.repo', () => ({
  kbRepo: {
    get: (id: string) => (mocks.kb && mocks.kb.id === id ? mocks.kb : null),
    setEmbeddingDim: (id: string, dim: number) => mocks.dimSet.push({ id, dim })
  }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: {
    get: () => mocks.doc,
    setStatus: (_id: string, status: string, error?: string) => {
      mocks.statuses.push(status)
      mocks.errors.push(error ?? null)
      if (mocks.doc) {
        mocks.doc.status = status as KbDocument['status']
        mocks.doc.error = error ?? null
      }
    },
    setChunkCount: (id: string, n: number) => mocks.chunkCounts.push({ id, n })
  }
}))
vi.mock('../src/main/db/repositories/kb-chunk.repo', () => ({
  kbChunkRepo: {
    deleteByDoc: (docId: string) => mocks.deletedByDoc.push(docId),
    insertMany: (chunks: typeof mocks.inserted) => {
      mocks.inserted.push(...chunks)
    }
  }
}))
vi.mock('../src/main/knowledge/embedding', () => ({
  embedTexts: vi.fn(async (_providerId: string, _model: string, texts: string[]) => {
    mocks.embedCalls.push(texts.length)
    if (mocks.embedError) throw mocks.embedError
    return texts.map(() => Float32Array.from([0.1, 0.2, 0.3]))
  })
}))

import { IngestionService } from '../src/main/knowledge/ingestion'

// ---------- 构造夹具 ----------
function makeKb(over: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: 'kb1',
    name: '测试库',
    description: '',
    embeddingProviderId: 'p1',
    embeddingModel: 'text-embedding-3-small',
    embeddingDim: null,
    chunkSize: 50,
    chunkOverlap: 10,
    topK: 20,
    topN: 5,
    rerankProviderId: null,
    rerankModel: null,
    hydeProviderId: null,
    hydeModel: null,
    documentCount: 0,
    chunkCount: 0,
    createdAt: 0,
    ...over
  }
}
function makeDoc(source: string): KbDocument & { status: string; error: string | null } {
  return {
    id: 'doc1',
    kbId: 'kb1',
    title: 'doc.txt',
    source,
    sourceType: 'txt',
    status: 'pending',
    chunkCount: 0,
    error: null,
    createdAt: 0
  }
}
function writeTmp(content: string, name = 'doc.txt'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-ingest-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('IngestionService.ingestDocument — 入库状态机', () => {
  beforeEach(() => mocks.reset())

  it('知识库不存在 → 直接抛错（不落 error 状态）', async () => {
    mocks.kb = null
    const svc = new IngestionService()
    await expect(svc.ingestDocument('nope', 'doc1')).rejects.toThrow('知识库不存在')
    expect(mocks.statuses).toEqual([])
  })

  it('知识库未配置 Embedding → 抛配置错误', async () => {
    mocks.kb = makeKb({ embeddingProviderId: null, embeddingModel: null })
    mocks.doc = makeDoc('')
    const svc = new IngestionService()
    await expect(svc.ingestDocument('kb1', 'doc1')).rejects.toThrow('未配置 Embedding')
  })

  it('完整 happy path：parsing→indexing→ready，分块/向量/维度/计数全部落库', async () => {
    mocks.kb = makeKb()
    mocks.doc = makeDoc(writeTmp('字'.repeat(200)))
    const svc = new IngestionService()
    const result = await svc.ingestDocument('kb1', 'doc1')

    expect(result.status).toBe('ready')
    expect(mocks.statuses).toEqual(['parsing', 'indexing', 'ready'])

    // 重新索引前先清旧分块
    expect(mocks.deletedByDoc).toEqual(['doc1'])

    // 200 字 / 50 块 → 多块；序号连续；每块带 3 维向量
    expect(mocks.inserted.length).toBeGreaterThan(1)
    mocks.inserted.forEach((c, i) => {
      expect(c.sequence).toBe(i)
      expect(c.docId).toBe('doc1')
      expect(c.kbId).toBe('kb1')
      expect(c.embedding).toBeInstanceOf(Float32Array)
      expect(c.embedding.length).toBe(3)
    })

    // 首次入库写回维度
    expect(mocks.dimSet).toEqual([{ id: 'kb1', dim: 3 }])
    expect(mocks.chunkCounts[mocks.chunkCounts.length - 1]).toEqual({
      id: 'doc1',
      n: mocks.inserted.length
    })
  })

  it('已有维度的知识库不重复写回 embeddingDim', async () => {
    mocks.kb = makeKb({ embeddingDim: 1536 })
    mocks.doc = makeDoc(writeTmp('x'.repeat(200)))
    const svc = new IngestionService()
    await svc.ingestDocument('kb1', 'doc1')
    expect(mocks.dimSet).toEqual([])
  })

  it('解析后内容为空 → error 状态且消息落库，不调用向量化', async () => {
    mocks.kb = makeKb()
    mocks.doc = makeDoc(writeTmp('   \n\t  '))
    const svc = new IngestionService()
    const result = await svc.ingestDocument('kb1', 'doc1')

    expect(result.status).toBe('error')
    expect(result.error).toContain('内容为空')
    expect(mocks.embedCalls).toEqual([])
    expect(mocks.inserted).toEqual([])
  })

  it('向量化失败 → 错误被吞并落 error 状态，不写 ready（单文档失败不炸整库）', async () => {
    mocks.kb = makeKb()
    mocks.doc = makeDoc(writeTmp('y'.repeat(200)))
    mocks.embedError = new Error('Embedding API 503')
    const svc = new IngestionService()
    const result = await svc.ingestDocument('kb1', 'doc1')

    expect(result.status).toBe('error')
    expect(result.error).toContain('503')
    expect(mocks.statuses).not.toContain('ready')
    expect(mocks.inserted).toEqual([])
  })
})

describe('IngestionService.ingestText / ingestDocuments', () => {
  beforeEach(() => mocks.reset())

  it('ingestText：手工文本跳过解析直接索引到 ready', async () => {
    mocks.kb = makeKb()
    mocks.doc = makeDoc('manual://text')
    const svc = new IngestionService()
    const result = await svc.ingestText('kb1', 'doc1', '手'.repeat(120), '手工文档')

    expect(result.status).toBe('ready')
    // 直接文本不经过 parsing 状态
    expect(mocks.statuses).toEqual(['indexing', 'ready'])
    expect(mocks.inserted.length).toBeGreaterThan(1)
  })

  it('ingestDocuments：多文档顺序执行，结果顺序与入参一致', async () => {
    mocks.kb = makeKb()
    const docs = ['doc-a', 'doc-b', 'doc-c'].map((id, i) => ({
      ...makeDoc(writeTmp(`文档${i}内容`.repeat(20))),
      id
    }))
    const svc = new IngestionService()
    const results = []
    // 顺序切换当前夹具 doc（kbDocRepo.get 始终返回 mocks.doc）
    for (const d of docs) {
      mocks.doc = d
      // eslint-disable-next-line no-await-in-loop
      results.push(await svc.ingestDocument('kb1', d.id))
    }

    expect(results.map((r) => r.id)).toEqual(['doc-a', 'doc-b', 'doc-c'])
    expect(results.every((r) => r.status === 'ready')).toBe(true)
    // 每份文档都先清理旧分块
    expect(mocks.deletedByDoc).toEqual(['doc-a', 'doc-b', 'doc-c'])
  })
})
