// embedding 批量向量化服务测试
//
// 覆盖 src/main/knowledge/embedding.ts：
// - embedTexts：空数组短路 / 单批 / 超 BATCH_SIZE(32) 分批 / 返回数量不匹配抛错 / Float32Array 转换
// - embedQuery：正常返回首个向量 / 空结果抛错
//
// 策略：vi.mock providers/manager，adapter.embed 按批次记录调用
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { embedTexts, embedQuery } from '../src/main/knowledge/embedding'

const mocks = vi.hoisted(() => ({
  // adapter.embed 按调用顺序记录每批入参
  embedCalls: [] as string[][],
  // 每批返回的向量（函数形式：batch => vectors）
  embedImpl: null as null | ((batch: string[]) => number[][]),
  reset() {
    this.embedCalls = []
    this.embedImpl = null
  }
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      embed: async (batch: string[]) => {
        mocks.embedCalls.push(batch)
        if (mocks.embedImpl) return mocks.embedImpl(batch)
        return batch.map((t) => [t.length, 1])
      }
    })
  }
}))

beforeEach(() => mocks.reset())

// ---------- embedTexts ----------

describe('embedTexts 批量向量化', () => {
  it('空数组：短路返回 []，不调 adapter', async () => {
    const r = await embedTexts('p', 'm', [])
    expect(r).toEqual([])
    expect(mocks.embedCalls).toEqual([])
  })

  it('单批（<32 条）：一次请求，返回等长向量并转为 Float32Array', async () => {
    const r = await embedTexts('p', 'm', ['a', 'bb', 'ccc'])
    expect(mocks.embedCalls).toEqual([['a', 'bb', 'ccc']])
    expect(r).toHaveLength(3)
    for (const v of r) expect(v).toBeInstanceOf(Float32Array)
    expect(Array.from(r[0]!)).toEqual([1, 1])
    expect(Array.from(r[2]!)).toEqual([3, 1])
  })

  it('超 32 条：按 32 分批依次请求，顺序保持', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`)
    const r = await embedTexts('p', 'm', texts)
    // 3 批：32 + 32 + 6
    expect(mocks.embedCalls.map((b) => b.length)).toEqual([32, 32, 6])
    expect(mocks.embedCalls[0]![0]).toBe('t0')
    expect(mocks.embedCalls[1]![0]).toBe('t32')
    expect(mocks.embedCalls[2]![0]).toBe('t64')
    expect(r).toHaveLength(70)
    expect(Array.from(r[69]!)).toEqual([3, 1]) // 't69'.length === 3
  })

  it('某批返回数量不匹配：抛错并带期望/实际数量', async () => {
    mocks.embedImpl = (batch) => batch.slice(0, -1).map((t) => [t.length, 1])
    await expect(embedTexts('p', 'm', ['a', 'bb', 'ccc'])).rejects.toThrow(
      '向量化返回数量不匹配：期望 3，实际 2'
    )
  })

  it('第二批不匹配：前一批结果不误报', async () => {
    const texts = Array.from({ length: 33 }, (_, i) => `t${i}`)
    mocks.embedImpl = (batch) =>
      batch.length === 32
        ? batch.map((t) => [t.length, 1])
        : batch.map((t) => [t.length, 1]).slice(0, -1)
    await expect(embedTexts('p', 'm', texts)).rejects.toThrow('期望 1，实际 0')
  })
})

// ---------- embedQuery ----------

describe('embedQuery 查询向量化', () => {
  it('正常：返回首个向量并转为 Float32Array，单条请求', async () => {
    const r = await embedQuery('p', 'm', '查询')
    expect(mocks.embedCalls).toEqual([['查询']])
    expect(r).toBeInstanceOf(Float32Array)
    expect(Array.from(r)).toEqual([2, 1])
  })

  it('适配器返回空数组：抛「空结果」错误', async () => {
    mocks.embedImpl = () => []
    await expect(embedQuery('p', 'm', '查询')).rejects.toThrow('embedding 适配器返回空结果')
  })
})
