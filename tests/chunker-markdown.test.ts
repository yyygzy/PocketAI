// Markdown 结构感知分块测试
import { describe, it, expect } from 'vitest'
import { chunkMarkdown } from '../src/main/knowledge/chunker'

describe('chunkMarkdown 结构感知分块', () => {
  it('空文本 → []', () => {
    expect(chunkMarkdown('', { chunkSize: 100, chunkOverlap: 0 })).toEqual([])
  })

  it('纯空白 → []', () => {
    expect(chunkMarkdown('   \n  \t  ', { chunkSize: 100, chunkOverlap: 0 })).toEqual([])
  })

  it('纯文本无标题 → 退化为字符级切分（单块）', () => {
    const r = chunkMarkdown('hello world', { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(1)
    expect(r[0]?.content).toBe('hello world')
    expect(r[0]?.sequence).toBe(0)
  })

  it('单标题短节 → 单块带标题前缀', () => {
    const r = chunkMarkdown('# 概述\n这是项目简介。', { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(1)
    expect(r[0]?.content).toBe('# 概述\n这是项目简介。')
  })

  it('多级标题 → 每节带完整标题链前缀', () => {
    const md = '# 项目\n\n## 安装\nnpm i\n\n## 配置\n配置说明'
    const r = chunkMarkdown(md, { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('# 项目 > ## 安装\nnpm i')
    expect(r[1]?.content).toBe('# 项目 > ## 配置\n配置说明')
  })

  it('同级标题不累积链：## A 后接 ## B，B 的链不含 A', () => {
    const md = '# 根\n## A\na 内容\n## B\nb 内容'
    const r = chunkMarkdown(md, { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('# 根 > ## A\na 内容')
    expect(r[1]?.content).toBe('# 根 > ## B\nb 内容')
  })

  it('长节 → 节内字符切分，每块带前缀', () => {
    // 50 字符正文，chunkSize=30，前缀 '# 标题\n' 占 6，预算=24
    const body = 'a'.repeat(50)
    const md = `# 标题\n${body}`
    const r = chunkMarkdown(md, { chunkSize: 30, chunkOverlap: 0 })
    expect(r.length).toBeGreaterThan(1)
    r.forEach((c) => {
      expect(c.content.startsWith('# 标题\n')).toBe(true)
    })
  })

  it('代码块内的 # 不当作标题', () => {
    const md = '# 真实标题\n```\n# 不是标题\n代码内容\n```\n正文'
    const r = chunkMarkdown(md, { chunkSize: 200, chunkOverlap: 0 })
    // 只有一个节（# 真实标题），代码块内容并入该节
    expect(r).toHaveLength(1)
    expect(r[0]?.content).toContain('# 不是标题')
    expect(r[0]?.content).toContain('代码内容')
  })

  it('标题链超长时截断，保留最近几级', () => {
    const md = '# 一级标题很长很长很长很长\n## 二级\n内容'
    // chunkSize=30，maxPrefixLen=15，前缀会被截断
    const r = chunkMarkdown(md, { chunkSize: 30, chunkOverlap: 0 })
    expect(r).toHaveLength(1)
    // 前缀不超过 15 字符 + '\n'
    const prefixEnd = r[0]!.content.indexOf('\n')
    expect(prefixEnd).toBeLessThanOrEqual(16)
  })

  it('sequence 全局递增', () => {
    const md = '# A\na1\n\n# B\nb1\n\n# C\nc1'
    const r = chunkMarkdown(md, { chunkSize: 100, chunkOverlap: 0 })
    expect(r.map((c) => c.sequence)).toEqual([0, 1, 2])
  })

  it('文档开头无标题的前言部分独立成块（无前缀）', () => {
    const md = '前言文字\n\n# 标题\n正文'
    const r = chunkMarkdown(md, { chunkSize: 100, chunkOverlap: 0 })
    expect(r).toHaveLength(2)
    expect(r[0]?.content).toBe('前言文字')
    expect(r[1]?.content).toBe('# 标题\n正文')
  })
})
