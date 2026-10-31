import { describe, it, expect } from 'vitest'
import { formatBytes } from '../src/renderer/src/utils/format'

describe('formatBytes', () => {
  // §378：0 与「拿不到」以前共用一个 '-'，于是"确实没有"和"读失败"在屏上长成同一个串
  //（数据健康屏那七个体积格、清理后「回收 0 字节」全被画成 '-'）。现在分两档。
  it('0 是"确实没有"：说 0 B，不许再借破折号演"没读到"', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('只有拿不到（非有限值／负数）才说 "-"', () => {
    expect(formatBytes(-1)).toBe('-')
    expect(formatBytes(NaN)).toBe('-')
    expect(formatBytes(Infinity)).toBe('-')
    expect(formatBytes(-Infinity)).toBe('-')
  })

  it('B 单位：< 1024 显示整数 B', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(100)).toBe('100 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('KB 单位：1024~1048575，<100 保留 1 位，≥100 取整', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(102400)).toBe('100 KB')
  })

  it('MB/GB/TB 单位逐级换算', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB')
  })

  it('超过 TB 仍停在 TB 单位', () => {
    const huge = 1024 * 1024 * 1024 * 1024 * 1024
    expect(formatBytes(huge)).toBe('1024 TB')
  })
})
