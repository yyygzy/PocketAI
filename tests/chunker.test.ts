// 文本分块纯函数测试
//
// 覆盖 src/main/knowledge/chunker.ts 的核心路径：
// - findLast：边界查找（lastIndexOf + minPos 过滤 + token 结束位置）
// - chunkText：空文本/短文本/长文本多块/段落·句号·换行·空格边界断开/无边界整块切/重叠推进/文本规范化
//
// 策略：纯函数无外部依赖，直接 import 断言。chunkSize=10 / half=5 便于构造边界命中场景。
import { describe, it, expect } from 'vitest'
import { findLast, chunkText } from '../src/main/knowledge/chunker'

// ---------- findLast 纯函数 ----------

describe('findLast 纯函数', () => {
  it('找到且 idx >= minPos：返回 token 结束位置', () => {
    // slice="abcde\n\nfgh", token="\n\n" 在 idx=5, minPos=5 → 命中，返回 5+2=7
    expect(findLast('abcde\n\nfgh', '\n\n', 5)).toBe(7)
  })

  it('首个 idx < minPos：往前找 >= minPos 的，都 < minPos 返回 -1', () => {
    // slice="ab\nfg\nh", token="\n" 在 idx=2 和 5；minPos=4 → idx=2<4 跳过，idx=5>=4 命中，返回 6
    expect(findLast('ab\nfg\nh', '\n', 4)).toBe(6)
    // 全部 < minPos → -1
    expect(findLast('ab\ncd', '\n', 5)).toBe(-1)
  })

  it('找不到：返回 -1', () => {
    expect(findLast('abcdef', '\n', 0)).toBe(-1)
  })
})

// ---------- chunkText 分块 ----------

describe('chunkText 分块', () => {
  it('空文本 → []', () => {
    expect(chunkText('', { chunkSize: 10, chunkOverlap: 0 })).toEqual([])
  })

  it('纯空白文本 normalize 后为空 → []', () => {
    expect(chunkText('   \n  \t  ', { chunkSize: 10, chunkOverlap: 0 })).toEqual([])
  })

  it('短文本 ≤ chunkSize → 单块，sequence=0', () => {
    const r = chunkText('hello', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(1)
    expect(r[0]?.content).toBe('hello')
    expect(r[0]?.sequence).toBe(0)
  })

  it('长文本无边界 → 按整块切，多块，sequence 递增', () => {
    // 20 字符无任何边界，chunkSize=10 → 2 块
    const r = chunkText('aaaaaaaaaabbbbbbbbbb', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('aaaaaaaaaa')
    expect(r[0]?.sequence).toBe(0)
    expect(r[1]?.content).toBe('bbbbbbbbbb')
    expect(r[1]?.sequence).toBe(1)
  })

  it('段落边界断开（\\n\\n）', () => {
    // "aaaaa\n\nbbbbb"（12 字符），chunkSize=10，\n\n 在 idx=5 >= half(5) 命中
    const r = chunkText('aaaaa\n\nbbbbb', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('aaaaa')
    expect(r[1]?.content).toBe('bbbbb')
  })

  it('中文句号断开（。）', () => {
    // "aaaaa。bbbbb"（12 字符），chunkSize=10，。 在 idx=5 >= half(5) 命中
    const r = chunkText('aaaaa。bbbbb', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('aaaaa。')
    expect(r[1]?.content).toBe('bbbbb')
  })

  it('英文句号断开（. ）', () => {
    // "Hello. World"（12 字符），chunkSize=10，". " 在 idx=5 >= half(5) 命中
    const r = chunkText('Hello. World', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('Hello.')
    expect(r[1]?.content).toBe('World')
  })

  it('换行断开（\\n）', () => {
    // "aaaaa\nbbbbb"（11 字符），chunkSize=10，\n 在 idx=5 >= half(5) 命中
    const r = chunkText('aaaaa\nbbbbb', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('aaaaa')
    expect(r[1]?.content).toBe('bbbbb')
  })

  it('空格断开（无换行时）', () => {
    // "aaaaa bbbbb"（11 字符），chunkSize=10，空格 在 idx=5 >= half(5) 命中
    const r = chunkText('aaaaa bbbbb', { chunkSize: 10, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('aaaaa')
    expect(r[1]?.content).toBe('bbbbb')
  })

  it('重叠推进：overlap>0 块数多于 overlap=0', () => {
    // "abcdefghij"（10 字符，无边界），chunkSize=5
    // overlap=0 → 2 块；overlap=2 → advance=max(5-2,1)=3，3 块
    const r0 = chunkText('abcdefghij', { chunkSize: 5, chunkOverlap: 0 })
    expect(r0).toHaveLength(2)
    const r2 = chunkText('abcdefghij', { chunkSize: 5, chunkOverlap: 2 })
    expect(r2).toHaveLength(3)
    expect(r2[0]?.content).toBe('abcde')
    expect(r2[1]?.content).toBe('defgh')
    expect(r2[2]?.content).toBe('ghij')
  })

  it('文本规范化：\\r\\n → \\n / \\u00a0 → 空格 / \\n{3,} → \\n\\n / 首尾 trim', () => {
    // 构造含 \r\n、\u00a0、多换行、首尾空白的文本，chunkSize 足够大使其归为单块
    const r = chunkText('  a\r\nb\u00a0c\n\n\n\nd  ', { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(1)
    // \r\n→\n, \u00a0→空格, \n{3,}→\n\n, 首尾 trim
    expect(r[0]?.content).toBe('a\nb c\n\nd')
  })
})
