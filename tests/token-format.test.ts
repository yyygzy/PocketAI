// token / 费用格式化测试（用量面板与聊天气泡共用 utils/token.ts）
import { describe, it, expect } from 'vitest'
import { fmtTokens, fmtCost } from '../src/renderer/src/utils/token'

describe('fmtTokens — 数量级缩写', () => {
  it('<1000 原样输出', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
  })

  it('≥1000 显示 k（<100k 一位小数，≥100k 取整）', () => {
    expect(fmtTokens(1000)).toBe('1.0k')
    expect(fmtTokens(1500)).toBe('1.5k')
    expect(fmtTokens(99_999)).toBe('100.0k')
    expect(fmtTokens(100_000)).toBe('100k')
  })

  it('≥1M 显示 M（<10M 一位小数，≥10M 取整）', () => {
    expect(fmtTokens(1_000_000)).toBe('1.0M')
    expect(fmtTokens(2_500_000)).toBe('2.5M')
    expect(fmtTokens(10_000_000)).toBe('10M')
  })
})

describe('fmtCost — 费用精度', () => {
  it('0 / 负数 / NaN → 空串（UI 隐藏费用）', () => {
    expect(fmtCost(0)).toBe('')
    expect(fmtCost(-1)).toBe('')
    expect(fmtCost(NaN)).toBe('')
  })

  it('0<n<1 四位小数', () => {
    expect(fmtCost(0.5)).toBe('0.5000')
    expect(fmtCost(0.001)).toBe('0.0010')
  })

  it('≥1 两位小数', () => {
    expect(fmtCost(1)).toBe('1.00')
    expect(fmtCost(1.239)).toBe('1.24')
  })
})
