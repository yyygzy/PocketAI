// KB 升级阶段 1：配置变更 → 重建提示的纯函数判定
import { describe, it, expect } from 'vitest'
import { countDocsNeedingReindex, detectKbConfigChanges } from '../src/main/knowledge/reindex-detection'
import type { KbDocument, KnowledgeBase } from '../src/shared/types'

type KbConfigFields = Pick<
  KnowledgeBase,
  'embeddingProviderId' | 'embeddingModel' | 'embeddingDim' | 'chunkSize' | 'chunkOverlap'
>

const existing = (over: Partial<KbConfigFields> = {}): KbConfigFields => ({
  embeddingProviderId: 'p1',
  embeddingModel: 'm1',
  embeddingDim: 3,
  chunkSize: 800,
  chunkOverlap: 200,
  ...over
})

const doc = (over: Partial<KbDocument> = {}): KbDocument =>
  ({
    id: 'd', status: 'ready', chunkCount: 1, ...over
  }) as unknown as KbDocument

describe('detectKbConfigChanges — 配置变更判定', () => {
  it('新建库（无旧配置）不提示', () => {
    expect(detectKbConfigChanges(null, { embeddingModel: 'm1', chunkSize: 800 })).toEqual({
      embeddingChanged: false,
      chunkingChanged: false,
      needReindex: false
    })
  })

  it('Embedding provider 变更 ⇒ 需重建', () => {
    expect(detectKbConfigChanges(existing(), { embeddingProviderId: 'p2' })).toEqual({
      embeddingChanged: true,
      chunkingChanged: false,
      needReindex: true
    })
  })

  it('Embedding model 变更 ⇒ 需重建', () => {
    expect(detectKbConfigChanges(existing(), { embeddingModel: 'm2' })).toEqual({
      embeddingChanged: true,
      chunkingChanged: false,
      needReindex: true
    })
  })

  it('旧库无向量维度时改模型不提示（与旧行为一致：还谈不上旧向量失配）', () => {
    const r = detectKbConfigChanges(existing({ embeddingDim: null }), { embeddingModel: 'm2' })
    expect(r.embeddingChanged).toBe(false)
    expect(r.needReindex).toBe(false)
  })

  it('分块大小变更 ⇒ 需重建', () => {
    const r = detectKbConfigChanges(existing(), { chunkSize: 1200 })
    expect(r.chunkingChanged).toBe(true)
    expect(r.embeddingChanged).toBe(false)
    expect(r.needReindex).toBe(true)
  })

  it('分块重叠变更 ⇒ 需重建', () => {
    expect(detectKbConfigChanges(existing(), { chunkOverlap: 100 }).chunkingChanged).toBe(true)
  })

  it('partial 入参未传的字段不算变更', () => {
    expect(detectKbConfigChanges(existing(), { name: '仅改名' } as never)).toEqual({
      embeddingChanged: false,
      chunkingChanged: false,
      needReindex: false
    })
  })

  it('Embedding 与分块同时变更 ⇒ 两类标记都为真', () => {
    const r = detectKbConfigChanges(existing(), { embeddingModel: 'm2', chunkSize: 1200 })
    expect(r).toEqual({ embeddingChanged: true, chunkingChanged: true, needReindex: true })
  })
})

describe('countDocsNeedingReindex — 受影响文档数', () => {
  it('ready 或有分块的文档计入，pending/error 且无分块的不计', () => {
    expect(
      countDocsNeedingReindex([
        doc({ status: 'ready', chunkCount: 3 }),
        doc({ id: 'b', status: 'error', chunkCount: 2 }),
        doc({ id: 'c', status: 'pending', chunkCount: 0 }),
        doc({ id: 'd', status: 'ready', chunkCount: 0 })
      ])
    ).toBe(3)
  })

  it('空库返回 0', () => {
    expect(countDocsNeedingReindex([])).toBe(0)
  })
})
