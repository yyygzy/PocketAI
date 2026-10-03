// Shift 范围连选纯函数测试
import { describe, it, expect } from 'vitest'
import { rangeBetween, mergeRange } from '../src/renderer/src/utils/message-select'

const IDS = ['m1', 'm2', 'm3', 'm4', 'm5']

describe('rangeBetween', () => {
  it('锚点在前：含两端的正序区间', () => {
    expect(rangeBetween(IDS, 'm1', 'm4')).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
  it('锚点在后：反向也按列表顺序返回', () => {
    expect(rangeBetween(IDS, 'm5', 'm2')).toEqual(['m2', 'm3', 'm4', 'm5'])
  })
  it('锚点与目标相同：仅该 id', () => {
    expect(rangeBetween(IDS, 'm3', 'm3')).toEqual(['m3'])
  })
  it('锚点为 null：退化为仅目标', () => {
    expect(rangeBetween(IDS, null, 'm2')).toEqual(['m2'])
  })
  it('锚点不在列表：退化为仅目标；目标也不在则空数组', () => {
    expect(rangeBetween(IDS, 'x', 'm2')).toEqual(['m2'])
    expect(rangeBetween(IDS, 'm1', 'x')).toEqual([])
  })
})

describe('mergeRange', () => {
  it('区间并入既有选择（纯添加，区间外保留）', () => {
    const next = mergeRange(new Set(['m1']), ['m3', 'm4'])
    expect(Array.from(next)).toEqual(['m1', 'm3', 'm4'])
  })
  it('不改入参 Set，返回新实例', () => {
    const prev = new Set(['m1'])
    const next = mergeRange(prev, ['m2'])
    expect(next).not.toBe(prev)
    expect(prev.has('m2')).toBe(false)
  })
  it('空区间等价于拷贝', () => {
    const next = mergeRange(new Set(['m1', 'm2']), [])
    expect(Array.from(next)).toEqual(['m1', 'm2'])
  })
})
