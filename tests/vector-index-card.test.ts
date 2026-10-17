// 数据健康「向量索引」卡片文案（真字典插值，防漏翻译与占位符漂移）
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { formatVectorIndex } from '../src/renderer/src/utils/vector-index'

const ZH = zh as Record<string, string>
const t = (key: string, vars?: Record<string, string | number>): string =>
  (ZH[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''))

describe('formatVectorIndex', () => {
  it('从未建索引 → 「未建立」（不是 0 条、也不是 -）', () => {
    expect(formatVectorIndex({ count: 0, dims: [] }, t)).toBe(zh['dh.vectorIndexNone'])
    expect(formatVectorIndex({ count: 0, dims: [1024] }, t)).toBe(zh['dh.vectorIndexNone'])
  })

  it('单维度 → 条数千分位 + 维度', () => {
    expect(formatVectorIndex({ count: 1240, dims: [1024] }, t)).toBe('1,240 条 · 1024 维')
  })

  it('多维度混用（换过 embedding 模型）→ 维度并列，一眼能看出不是单一套', () => {
    expect(formatVectorIndex({ count: 5, dims: [512, 1024] }, t)).toBe('5 条 · 512/1024 维')
  })

  it('dims 为空但有计数（脏数据）→ 维度位显示 ? 而不是留白', () => {
    expect(formatVectorIndex({ count: 3, dims: [] }, t)).toBe('3 条 · ? 维')
  })
})
