// MMR 多样性重排纯函数测试
import { describe, it, expect } from 'vitest'
import { mmrSelect } from '../src/main/knowledge/mmr'
import type { RetrievedChunk } from '../src/shared/types'

function chunk(id: string, score: number): RetrievedChunk {
  return { chunkId: id, docId: `doc-${id}`, docTitle: '', content: `content-${id}`, score }
}

function v(...vals: number[]): Float32Array {
  return new Float32Array(vals)
}

describe('mmrSelect 多样性重排', () => {
  it('count <= 0 → []', () => {
    expect(mmrSelect([chunk('a', 1)], new Map(), 0)).toEqual([])
  })

  it('候选数 <= count → 原样返回', () => {
    const c = [chunk('a', 1), chunk('b', 0.8)]
    expect(mmrSelect(c, new Map(), 5).map((x) => x.chunkId)).toEqual(['a', 'b'])
  })

  it('无向量时退化为按相关性取前 count（等同 slice）', () => {
    const c = [chunk('a', 0.9), chunk('b', 0.8), chunk('c', 0.7), chunk('d', 0.6)]
    const picked = mmrSelect(c, new Map(), 2)
    expect(picked.map((x) => x.chunkId)).toEqual(['a', 'b'])
  })

  it('第一条总是相关性最高的', () => {
    const c = [chunk('a', 0.3), chunk('b', 0.95), chunk('c', 0.6)]
    const picked = mmrSelect(c, new Map(), 2)
    expect(picked[0]?.chunkId).toBe('b')
  })

  it('高相似候选被多样性惩罚：第二个位置让给语义不同的候选', () => {
    // a 与 b 向量几乎相同（重复内容），c 语义不同
    const c = [
      chunk('a', 0.95),
      chunk('b', 0.94), // a 的近重复
      chunk('c', 0.8) // 相关但不同主题
    ]
    const vecs = new Map<string, Float32Array>([
      ['a', v(1, 0)],
      ['b', v(0.99, 0.01)],
      ['c', v(0, 1)]
    ])
    // lambda=0.3 偏多样性
    const picked = mmrSelect(c, vecs, 2, 0.3)
    expect(picked.map((x) => x.chunkId)).toEqual(['a', 'c'])
  })

  it('lambda=1 时纯按相关性，重复内容仍被选', () => {
    const c = [chunk('a', 0.95), chunk('b', 0.94), chunk('c', 0.8)]
    const vecs = new Map<string, Float32Array>([
      ['a', v(1, 0)],
      ['b', v(0.99, 0.01)],
      ['c', v(0, 1)]
    ])
    const picked = mmrSelect(c, vecs, 2, 1)
    expect(picked.map((x) => x.chunkId)).toEqual(['a', 'b'])
  })

  it('不同维度的向量互不惩罚', () => {
    const c = [chunk('a', 0.9), chunk('b', 0.85), chunk('cc', 0.8)]
    const vecs = new Map<string, Float32Array>([
      ['a', v(1, 0, 0)], // 3 维
      ['b', v(1, 0)], // 2 维
      ['cc', v(0.9, 0.1, 0)] // 3 维，与 a 很近
    ])
    // b 与 a 维度不同不惩罚；cc 与 a 同维且高相似被惩罚
    const picked = mmrSelect(c, vecs, 2, 0.3)
    expect(picked[0]?.chunkId).toBe('a')
    expect(picked[1]?.chunkId).toBe('b')
  })

  it('全部相关性相等时第一条取候选 0，后续不报错', () => {
    const c = [chunk('a', 1), chunk('b', 1), chunk('c', 1)]
    const picked = mmrSelect(c, new Map(), 2)
    expect(picked.map((x) => x.chunkId)).toEqual(['a', 'b'])
  })

  it('结果数量等于 count（候选充足时）', () => {
    const c = Array.from({ length: 10 }, (_, i) => chunk(`c${i}`, 1 - i * 0.05))
    const vecs = new Map(
      c.map((x, i) => [x.chunkId, v(1 - i * 0.1, i * 0.1)] as const)
    )
    expect(mmrSelect(c, vecs, 4)).toHaveLength(4)
  })
})
