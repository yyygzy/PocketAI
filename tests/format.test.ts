import { describe, it, expect } from 'vitest'
import { formatBytes } from '../src/renderer/src/utils/format'

describe('formatBytes', () => {
  it('非有限值或 ≤0 返回 "-"', () => {
    expect(formatBytes(0)).toBe('-')
    expect(formatBytes(-1)).toBe('-')
    expect(formatBytes(NaN)).toBe('-')
    expect(formatBytes(Infinity)).toBe('-')
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
