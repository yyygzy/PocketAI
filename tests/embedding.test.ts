// 内置本地 embedding 测试：分派逻辑（mock）+ 真实推理冒烟（模型已在 resources/models）
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

// —— 分派逻辑测试：mock 本地引擎与 provider 适配器 ——
vi.mock('../src/main/knowledge/local-embedding', () => ({
  localEmbedTexts: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(512).fill(0.1))),
  localEmbedQuery: vi.fn(async () => new Float32Array(512).fill(0.2))
}))

const embedSpy = vi.fn(async (batch: string[]) => batch.map(() => new Float32Array(3).fill(0.5)))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { getAdapter: () => ({ embed: embedSpy }) }
}))

import { embedTexts, embedQuery, withBuiltinQueryPrefix } from '../src/main/knowledge/embedding'
import { localEmbedTexts, localEmbedQuery } from '../src/main/knowledge/local-embedding'
import { BUILTIN_EMBED_PROVIDER_ID, BUILTIN_QUERY_PREFIX } from '../src/shared/types'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('embedding 分派 — builtin 走本地引擎', () => {
  it('embedTexts: builtin 分派到 localEmbedTexts，不触碰 providerManager', async () => {
    const out = await embedTexts(BUILTIN_EMBED_PROVIDER_ID, 'x', ['a', 'b'])
    expect(localEmbedTexts).toHaveBeenCalledWith(['a', 'b'])
    expect(out).toHaveLength(2)
    expect(embedSpy).not.toHaveBeenCalled()
  })

  it('embedTexts: builtin 大批次按 32 分桶', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`)
    await embedTexts(BUILTIN_EMBED_PROVIDER_ID, 'x', texts)
    // 70 = 32 + 32 + 6
    expect(localEmbedTexts).toHaveBeenCalledTimes(3)
    expect((localEmbedTexts as ReturnType<typeof vi.mocked<typeof localEmbedTexts>>).mock.calls[2]![0]).toHaveLength(6)
  })

  it('embedTexts: 非 builtin 走 provider adapter，数量校验不变', async () => {
    const out = await embedTexts('p1', 'm1', ['a'])
    expect(embedSpy).toHaveBeenCalledWith(['a'], 'm1')
    expect(localEmbedTexts).not.toHaveBeenCalled()
    expect(out).toHaveLength(1)
  })

  it('embedQuery: builtin 分派到 localEmbedQuery', async () => {
    const vec = await embedQuery(BUILTIN_EMBED_PROVIDER_ID, 'x', '查询')
    expect(localEmbedQuery).toHaveBeenCalledWith('查询')
    expect(vec).toHaveLength(512)
    expect(embedSpy).not.toHaveBeenCalled()
  })

  it('withBuiltinQueryPrefix: 无前缀补齐、有前缀幂等', () => {
    const q = '什么是向量检索'
    expect(withBuiltinQueryPrefix(q)).toBe(`${BUILTIN_QUERY_PREFIX}${q}`)
    expect(withBuiltinQueryPrefix(`${BUILTIN_QUERY_PREFIX}${q}`)).toBe(`${BUILTIN_QUERY_PREFIX}${q}`)
  })
})
