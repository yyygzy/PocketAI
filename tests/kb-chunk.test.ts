// kb-chunk 向量相似度与 Buffer 转换测试
//
// 覆盖 src/main/db/repositories/kb-chunk.repo.ts 的三个纯函数：
// - cosineSimilarity：两个 Float32Array 的余弦相似度
// - bufferToFloat32：BLOB Buffer → Float32Array（对齐处理，空→null）
// - float32ToBuffer：Float32Array → Buffer
//
// 策略：三函数均不依赖 DB 连接；mock dbService 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))

import { cosineSimilarity, bufferToFloat32, float32ToBuffer } from '../src/main/db/repositories/kb-chunk.repo'

function f32(arr: number[]): Float32Array {
  return new Float32Array(arr)
}

// ── cosineSimilarity ─────────────────────────────────────
describe('cosineSimilarity — 余弦相似度', () => {
  it('同向向量 → 1', () => {
    expect(cosineSimilarity(f32([1, 0]), f32([1, 0]))).toBeCloseTo(1)
    expect(cosineSimilarity(f32([3, 4]), f32([6, 8]))).toBeCloseTo(1)
  })

  it('正交向量 → 0', () => {
    expect(cosineSimilarity(f32([1, 0]), f32([0, 1]))).toBeCloseTo(0)
  })

  it('反向向量 → -1', () => {
    expect(cosineSimilarity(f32([1, 0]), f32([-1, 0]))).toBeCloseTo(-1)
  })

  it('一般向量 → 点积 / (|a|*|b|)', () => {
    // a=[1,1], b=[1,0]; cos = 1/(√2*1) = √2/2 ≈ 0.7071
    expect(cosineSimilarity(f32([1, 1]), f32([1, 0]))).toBeCloseTo(Math.SQRT1_2)
  })

  it('零向量 a → 0', () => {
    expect(cosineSimilarity(f32([0, 0]), f32([1, 1]))).toBe(0)
  })

  it('零向量 b → 0', () => {
    expect(cosineSimilarity(f32([1, 1]), f32([0, 0]))).toBe(0)
  })

  it('两零向量 → 0', () => {
    expect(cosineSimilarity(f32([0, 0]), f32([0, 0]))).toBe(0)
  })

  it('高维向量正确计算', () => {
    const a = f32([1, 2, 3, 4, 5])
    const b = f32([5, 4, 3, 2, 1])
    const dot = 1 * 5 + 2 * 4 + 3 * 3 + 4 * 2 + 5 * 1
    const na = Math.sqrt(1 + 4 + 9 + 16 + 25)
    const nb = Math.sqrt(25 + 16 + 9 + 4 + 1)
    expect(cosineSimilarity(a, b)).toBeCloseTo(dot / (na * nb))
  })
})

// ── bufferToFloat32 / float32ToBuffer ───────────────────
describe('bufferToFloat32 — BLOB → Float32Array', () => {
  it('null → null', () => {
    expect(bufferToFloat32(null)).toBeNull()
  })

  it('空 Buffer → null', () => {
    expect(bufferToFloat32(Buffer.alloc(0))).toBeNull()
  })

  it('正常 4 字节对齐 Buffer → Float32Array', () => {
    const buf = Buffer.alloc(8)
    buf.writeFloatLE(1.5, 0)
    buf.writeFloatLE(2.5, 4)
    const vec = bufferToFloat32(buf)
    expect(vec).not.toBeNull()
    expect(vec!.length).toBe(2)
    expect(vec![0]).toBeCloseTo(1.5)
    expect(vec![1]).toBeCloseTo(2.5)
  })

  it('非对齐 Buffer（byteOffset≠0）→ 仍正确解析', () => {
    // 创建一个 byteOffset 不为 0 的 Buffer 子视图
    const big = Buffer.alloc(12)
    big.writeFloatLE(3.0, 4)
    const offsetBuf = big.subarray(4, 8) // byteOffset=4
    const vec = bufferToFloat32(offsetBuf)
    expect(vec).not.toBeNull()
    expect(vec!.length).toBe(1)
    expect(vec![0]).toBeCloseTo(3.0)
  })
})

describe('float32ToBuffer — Float32Array → Buffer', () => {
  it('Float32Array → 等长 Buffer', () => {
    const vec = f32([1.0, 2.0])
    const buf = float32ToBuffer(vec)
    expect(buf.byteLength).toBe(8)
    expect(buf.readFloatLE(0)!).toBeCloseTo(1.0)
    expect(buf.readFloatLE(4)!).toBeCloseTo(2.0)
  })

  it('空 Float32Array → 空 Buffer', () => {
    const buf = float32ToBuffer(f32([]))
    expect(buf.byteLength).toBe(0)
  })
})

describe('bufferToFloat32 ↔ float32ToBuffer 往返', () => {
  it('Float32Array → Buffer → Float32Array 一致', () => {
    const original = f32([1.1, 2.2, 3.3, 4.4])
    const buf = float32ToBuffer(original)
    const restored = bufferToFloat32(buf)
    expect(restored).not.toBeNull()
    expect(restored!.length).toBe(4)
    for (let i = 0; i < 4; i++) {
      expect(restored![i]!).toBeCloseTo(original[i]!)
    }
  })
})
