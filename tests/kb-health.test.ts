// kb-health 知识库数据健康测试
//
// 覆盖 src/main/knowledge/kb-health.ts：
// - findDuplicateGroups：同库同 hash 聚合 / 跨库不合并 / 无 hash 跳过 / 组内升序
// - collectProviderIssues：missing / disabled / model-missing / 未配置跳过 / 空模型列表不误报
// - reindexDocs / deduplicate：依赖 mock 仓库与队列的编排逻辑
import { describe, it, expect, vi } from 'vitest'

// mock 依赖链：db（better-sqlite3/electron）/各仓库/索引队列，仅保留编排逻辑所需的内存行为
const { docStore, queued } = vi.hoisted(() => ({
  docStore: new Map<string, import('../src/shared/types').KbDocument>(),
  queued: [] as Array<{ kbId: string; docId: string; kind: string }>
}))

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/app' } }))
vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) }),
    isVecEnabled: () => false
  }
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: {
    listAll: () => [...docStore.values()],
    list: (kbId: string) => [...docStore.values()].filter((d) => d.kbId === kbId),
    get: (id: string) => docStore.get(id) ?? null,
    delete: (id: string) => { docStore.delete(id) },
    setStatus: (id: string, status: KbDocument['status']) => {
      const d = docStore.get(id)
      if (d) d.status = status
    }
  }
}))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { list: () => [] } }))
vi.mock('../src/main/db/repositories/kb-vec.repo', () => ({
  kbVecRepo: { deleteByChunk: () => {}, deleteByDoc: () => {} }
}))
vi.mock('../src/main/db/repositories/provider.repo', () => ({ providerRepo: { list: () => [] } }))
vi.mock('../src/main/knowledge/index-queue', () => ({
  indexQueue: { enqueue: (task: { kbId: string; docId: string; kind: string }) => { queued.push(task) } }
}))

import { findDuplicateGroups, collectProviderIssues, reindexDocs, deduplicate } from '../src/main/knowledge/kb-health'
import type { KbDocument, KnowledgeBase, ProviderRecord } from '../src/shared/types'

let seq = 0
function mkDoc(p: Partial<KbDocument>): KbDocument {
  seq++
  return {
    id: p.id ?? `doc-${seq}`,
    kbId: p.kbId ?? 'kb-1',
    source: p.source ?? `file-${seq}.md`,
    sourceType: p.sourceType ?? 'md',
    title: p.title ?? `文档 ${seq}`,
    chunkCount: p.chunkCount ?? 1,
    status: p.status ?? 'ready',
    error: p.error ?? null,
    contentHash: p.contentHash ?? null,
    enabled: p.enabled ?? true,
    createdAt: p.createdAt ?? 1000 + seq
  }
}

const kbNameOf = (kbId: string) => (kbId === 'kb-1' ? '库一' : '库二')

describe('findDuplicateGroups', () => {
  it('同库同 hash 聚合为一组，组内按创建时间升序（最早在前）', () => {
    const docs = [
      mkDoc({ id: 'b', contentHash: 'h1', createdAt: 200 }),
      mkDoc({ id: 'a', contentHash: 'h1', createdAt: 100 }),
      mkDoc({ id: 'c', contentHash: 'h2' })
    ]
    const groups = findDuplicateGroups(docs, kbNameOf)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.hash).toBe('h1')
    expect(groups[0]!.docs.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('不同库同 hash 不合并；单篇不构成组', () => {
    const docs = [
      mkDoc({ kbId: 'kb-1', contentHash: 'h1' }),
      mkDoc({ kbId: 'kb-2', contentHash: 'h1' }),
      mkDoc({ contentHash: 'h2' })
    ]
    expect(findDuplicateGroups(docs, kbNameOf)).toHaveLength(0)
  })

  it('contentHash 为 null 的文档不参与检测', () => {
    const docs = [mkDoc({ contentHash: null, source: 'a.md' }), mkDoc({ contentHash: null, source: 'b.md' })]
    expect(findDuplicateGroups(docs, kbNameOf)).toHaveLength(0)
  })

  it('kbName 由注入函数解析', () => {
    const groups = findDuplicateGroups(
      [mkDoc({ contentHash: 'h1' }), mkDoc({ contentHash: 'h1', title: '副本' })],
      kbNameOf
    )
    expect(groups[0]!.kbName).toBe('库一')
  })
})

describe('collectProviderIssues', () => {
  const provider = (p: Partial<ProviderRecord> = {}): ProviderRecord => ({
    id: p.id ?? 'p1',
    type: 'openai-compatible',
    name: p.name ?? 'P1',
    baseUrl: p.baseUrl ?? 'https://api.example.com',
    apiKeys: p.apiKeys ?? ['k'],
    models: p.models ?? ['m1'],
    enabled: p.enabled ?? true,
    createdAt: 0
  })

  const kb = (overrides: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
    id: 'kb-1',
    name: '库一',
    description: '',
    embeddingProviderId: null,
    embeddingModel: null,
    embeddingDim: null,
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 20,
    topN: 5,
    rerankProviderId: null,
    rerankModel: null,
    hydeProviderId: null,
    hydeModel: null,
    multiQueryProviderId: null,
    multiQueryModel: null,
    ocrProviderId: null,
    ocrModel: null,
    documentCount: 0,
    chunkCount: 0,
    createdAt: 0,
    ...overrides
  })

  it('provider 已删除 → missing', () => {
    const issues = collectProviderIssues([kb({ embeddingProviderId: 'gone', embeddingModel: 'm1' })], [provider()])
    expect(issues).toEqual([{ kbId: 'kb-1', kbName: '库一', role: 'embedding', issue: 'missing' }])
  })

  it('provider 已禁用 → disabled；已删除优先于禁用', () => {
    const issues = collectProviderIssues(
      [
        kb({ id: 'a', embeddingProviderId: 'p-off', embeddingModel: 'm1' }),
        kb({ id: 'b', rerankProviderId: 'gone', rerankModel: 'm1' })
      ],
      [provider({ id: 'p-off', enabled: false })]
    )
    expect(issues).toContainEqual({ kbId: 'a', kbName: '库一', role: 'embedding', issue: 'disabled' })
    expect(issues).toContainEqual({ kbId: 'b', kbName: '库一', role: 'rerank', issue: 'missing' })
  })

  it('模型不在 provider 列表 → model-missing；列表为空不误报；正常配置无告警', () => {
    const miss = collectProviderIssues([kb({ embeddingProviderId: 'p1', embeddingModel: 'nope' })], [provider()])
    expect(miss).toEqual([{ kbId: 'kb-1', kbName: '库一', role: 'embedding', issue: 'model-missing' }])

    const emptyModels = collectProviderIssues(
      [kb({ embeddingProviderId: 'p1', embeddingModel: 'anything' })],
      [provider({ models: [] })]
    )
    expect(emptyModels).toEqual([])

    const ok = collectProviderIssues([kb({ embeddingProviderId: 'p1', embeddingModel: 'm1' })], [provider()])
    expect(ok).toEqual([])
  })

  it('未配置的引用（providerId 为空）跳过', () => {
    const issues = collectProviderIssues([kb({})], [])
    expect(issues).toEqual([])
  })
})

describe('reindexDocs / deduplicate（编排逻辑）', () => {
  it('重建索引：置 pending + 入队 reindex；文档不存在跳过', () => {
    docStore.clear()
    queued.length = 0
    const doc = mkDoc({ id: 'd1', kbId: 'kb-1', status: 'ready' })
    docStore.set('d1', doc)

    const r = reindexDocs(['d1', 'missing'])
    expect(r).toEqual({ enqueued: 1 })
    expect(doc.status).toBe('pending')
    expect(queued).toEqual([{ kbId: 'kb-1', docId: 'd1', kind: 'reindex' }])
  })

  it('去重：保留指定文档，删除同库同 hash 其余文档', () => {
    docStore.clear()
    const keep = mkDoc({ id: 'keep', kbId: 'kb-1', contentHash: 'h1', createdAt: 100 })
    const dup = mkDoc({ id: 'dup', kbId: 'kb-1', contentHash: 'h1', createdAt: 200 })
    const other = mkDoc({ id: 'other', kbId: 'kb-1', contentHash: 'h2' })
    docStore.set('keep', keep)
    docStore.set('dup', dup)
    docStore.set('other', other)

    expect(deduplicate('keep')).toEqual({ removed: 1 })
    expect(docStore.has('keep')).toBe(true)
    expect(docStore.has('dup')).toBe(false)
    expect(docStore.has('other')).toBe(true)
  })

  it('去重：无 hash / 文档不存在时抛错', () => {
    docStore.clear()
    docStore.set('nohash', mkDoc({ id: 'nohash', contentHash: null }))
    expect(() => deduplicate('nohash')).toThrow()
    expect(() => deduplicate('ghost')).toThrow()
  })
})
