// 相似度统计的口径（V4-Iter-127）
//
// KnowledgeModule 太大、没有挂载先例，面板显示只能肉眼；这里把「数字本身」的计算收进纯函数测死，
// 免得肉眼验收时把「中位数算错」这类问题当成显示问题。
import { describe, it, expect } from 'vitest'
import { similarityStats, fmtSim } from '../src/renderer/src/modules/knowledge/sim-stats'

describe('similarityStats', () => {
  it('全是 undefined ⇒ null（面板不显示，而不是报一个假的 0）', () => {
    expect(similarityStats([undefined, undefined])).toBeNull()
    expect(similarityStats([])).toBeNull()
  })

  it('只统计算得出相似度的那些条', () => {
    const s = similarityStats([0.9, undefined, 0.1, undefined])
    expect(s).toEqual({ count: 2, min: 0.1, median: 0.5, max: 0.9 })
  })

  it('奇数条取中间那个，偶数条取中间两个的平均', () => {
    expect(similarityStats([0.2, 0.9, 0.5])?.median).toBe(0.5)
    expect(similarityStats([0.2, 0.4, 0.6, 0.8])?.median).toBeCloseTo(0.5, 10)
  })

  it('乱序输入不影响结果（min/max 不是取首尾）', () => {
    const s = similarityStats([0.7, 0.1, 0.95, 0.3])
    expect(s).toEqual({ count: 4, min: 0.1, median: 0.5, max: 0.95 })
  })

  it('非有限值（NaN/Infinity）不参与统计，也不至于把结果整体吃掉', () => {
    const s = similarityStats([0.4, Number.NaN, Number.POSITIVE_INFINITY, 0.6])
    expect(s).toEqual({ count: 2, min: 0.4, median: 0.5, max: 0.6 })
    expect(similarityStats([Number.NaN])).toBeNull()
  })

  it('负相似度（反向匹配）也如实反映——阈值高于它必然滤掉', () => {
    const s = similarityStats([-0.2, 0.1])
    expect(s?.min).toBe(-0.2)
  })
})

describe('fmtSim', () => {
  it('两位小数，补齐尾零（面板上对齐可比）', () => {
    expect(fmtSim(1)).toBe('1.00')
    expect(fmtSim(0.5)).toBe('0.50')
    expect(fmtSim(0.12345)).toBe('0.12')
    expect(fmtSim(-0.05)).toBe('-0.05')
  })
})
