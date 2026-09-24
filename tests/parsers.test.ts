// knowledge/parsers detectSourceType 源类型推断测试
//
// 覆盖 src/main/knowledge/parsers/index.ts 的 detectSourceType：
// 根据文件路径或 URL 推断知识库源类型。
//
// 策略：纯函数，直接导入测试。
import { describe, it, expect } from 'vitest'
import { detectSourceType } from '../src/main/knowledge/parsers'

describe('detectSourceType — 源类型推断', () => {
  it('http:// URL → url', () => {
    expect(detectSourceType('http://example.com/doc')).toBe('url')
  })

  it('https:// URL → url', () => {
    expect(detectSourceType('https://example.com/doc.pdf')).toBe('url')
  })

  it('大写 HTTP → url（不区分大小写）', () => {
    expect(detectSourceType('HTTPS://example.com/doc')).toBe('url')
  })

  it('.pdf → pdf', () => {
    expect(detectSourceType('/docs/report.pdf')).toBe('pdf')
  })

  it('.docx → docx', () => {
    expect(detectSourceType('/docs/report.docx')).toBe('docx')
  })

  it('.xlsx → xlsx', () => {
    expect(detectSourceType('/data/sheet.xlsx')).toBe('xlsx')
  })

  it('.xls → xlsx', () => {
    expect(detectSourceType('/data/sheet.xls')).toBe('xlsx')
  })

  it('.html → html', () => {
    expect(detectSourceType('/web/page.html')).toBe('html')
  })

  it('.htm → html', () => {
    expect(detectSourceType('/web/page.htm')).toBe('html')
  })

  it('.md → md', () => {
    expect(detectSourceType('/notes/readme.md')).toBe('md')
  })

  it('.markdown → md', () => {
    expect(detectSourceType('/notes/readme.markdown')).toBe('md')
  })

  it('.txt → txt', () => {
    expect(detectSourceType('/data/log.txt')).toBe('txt')
  })

  it('.csv → txt（文本类）', () => {
    expect(detectSourceType('/data/data.csv')).toBe('txt')
  })

  it('.json → txt（文本类）', () => {
    expect(detectSourceType('/data/config.json')).toBe('txt')
  })

  it('未知扩展名 → txt（兜底）', () => {
    expect(detectSourceType('/data/unknown.xyz')).toBe('txt')
  })

  it('无扩展名 → txt', () => {
    expect(detectSourceType('/data/notes')).toBe('txt')
  })
})
