import { describe, it, expect } from 'vitest'
import {
  kbDocGetTextArgsSchema,
  kbDocUpdateTextArgsSchema,
  kbDocRenameArgsSchema,
  kbSaveSchema
} from '../src/shared/schemas/knowledge'

describe('knowledge 文档编辑/重命名 IPC schemas', () => {
  describe('kbDocGetTextArgsSchema', () => {
    it('合法 docId 通过', () => {
      expect(kbDocGetTextArgsSchema.safeParse(['doc1']).success).toBe(true)
    })
    it('缺参/空 id/非字符串被拒', () => {
      expect(kbDocGetTextArgsSchema.safeParse([]).success).toBe(false)
      expect(kbDocGetTextArgsSchema.safeParse(['']).success).toBe(false)
      expect(kbDocGetTextArgsSchema.safeParse([123]).success).toBe(false)
    })
  })

  describe('kbDocRenameArgsSchema', () => {
    it('合法 (docId, title) 通过', () => {
      const r = kbDocRenameArgsSchema.safeParse(['doc1', '新标题'])
      expect(r.success).toBe(true)
    })
    it('空标题/纯空白标题被拒（min(1)，UI 另做 trim）', () => {
      expect(kbDocRenameArgsSchema.safeParse(['doc1', '']).success).toBe(false)
    })
    it('标题超 500 字被拒', () => {
      expect(kbDocRenameArgsSchema.safeParse(['doc1', 'x'.repeat(501)]).success).toBe(false)
    })
    it('缺参数被拒', () => {
      expect(kbDocRenameArgsSchema.safeParse(['doc1']).success).toBe(false)
    })
  })

  describe('kbDocUpdateTextArgsSchema', () => {
    it('合法 (docId, title, text) 通过并保留原值', () => {
      const r = kbDocUpdateTextArgsSchema.safeParse(['doc1', '标题', '正文内容'])
      expect(r.success).toBe(true)
      if (r.success) expect(r.data).toEqual(['doc1', '标题', '正文内容'])
    })
    it('空标题被拒', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', '', '正文']).success).toBe(false)
    })
    it('空正文被拒', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', '标题', '']).success).toBe(false)
    })
    it('标题超 500 字被拒', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', 'x'.repeat(501), '正文']).success).toBe(false)
    })
    it('正文超 100 万字被拒', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', '标题', 'y'.repeat(1_000_001)]).success).toBe(false)
    })
    it('100 万字整恰好通过（边界）', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', '标题', 'y'.repeat(1_000_000)]).success).toBe(true)
    })
    it('参数个数不足被拒', () => {
      expect(kbDocUpdateTextArgsSchema.safeParse(['doc1', '标题']).success).toBe(false)
    })
  })

  // 相似度阈值（增强 B4）：它是 0–1 的小数，越界值必须当场拦住，
  // 否则会静默变成一个"看起来配了阈值其实永不生效/全滤光"的开关
  describe('kbSaveSchema.minScore', () => {
    it('0（不过滤）与 0 到 1 之间的小数都通过', () => {
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: 0 }).success).toBe(true)
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: 0.35 }).success).toBe(true)
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: 1 }).success).toBe(true)
    })

    it('不传 minScore 也通过（partial：编辑别的字段不该被要求填阈值）', () => {
      expect(kbSaveSchema.safeParse({ name: 'kb' }).success).toBe(true)
    })

    it('负数、大于 1、非数字被拒', () => {
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: -0.01 }).success).toBe(false)
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: 1.01 }).success).toBe(false)
      expect(kbSaveSchema.safeParse({ name: 'kb', minScore: '0.5' }).success).toBe(false)
    })

    it('0 不被当成「没填」——它是合法的关闭值', () => {
      const r = kbSaveSchema.safeParse({ name: 'kb', minScore: 0 })
      expect(r.success).toBe(true)
      expect((r as { data: { minScore: number } }).data.minScore).toBe(0)
    })
  })
})
