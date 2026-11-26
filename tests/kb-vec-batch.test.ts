// 阶段 5：sqlite-vec 超大库分批的边界验证（纯函数，不依赖 sqlite-vec 是否可用）
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.3.0'
  }
}))

import { chunkRowids } from '../src/main/db/repositories/kb-vec.repo'

describe('chunkRowids — sqlite-vec 大库分批', () => {
  it('空输入返回空，不足一批只出一批', () => {
    expect(chunkRowids([])).toEqual([])
    expect(chunkRowids([1, 2, 3], 5)).toEqual([[1, 2, 3]])
  })

  it('恰好整除不多出空批', () => {
    expect(chunkRowids([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })

  it('跨 32000 默认边界：顺序与元素完整无丢失', () => {
    const big = Array.from({ length: 32001 }, (_, i) => i)
    const chunks = chunkRowids(big)
    expect(chunks.map((c) => c.length)).toEqual([32000, 1])
    expect(chunks[0]![0]).toBe(0)
    expect(chunks[0]![31999]).toBe(31999)
    expect(chunks[1]![0]).toBe(32000)
    expect(chunks.flat()).toEqual(big)
  })

  it('十万 rowid 分出的每批都低于 SQLite 32766 bind 上限', () => {
    const big = Array.from({ length: 100_000 }, (_, i) => i)
    const chunks = chunkRowids(big)
    expect(chunks).toHaveLength(4)
    for (const c of chunks) expect(c.length).toBeLessThan(32_766)
  })

  it('非正整数批次大小直接拒绝', () => {
    expect(() => chunkRowids([1], 0)).toThrow(/positive integer/)
    expect(() => chunkRowids([1], 1.5)).toThrow(/positive integer/)
  })
})
