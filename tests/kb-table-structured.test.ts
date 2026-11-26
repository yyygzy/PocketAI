// 阶段 3：CSV/XLSX 结构化检索 — 真实解析 + 真实分块
// 验收核心：表头与关键词落在同一分块，且分块不切断「列名: 值」关系。
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { detectSourceType, parseDocumentBytes } from '../src/main/knowledge/parsers'
import { chunkMarkdown, chunkTableLines } from '../src/main/knowledge/chunker'

const csvBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))

describe('CSV 结构化解析', () => {
  it('表头 + 数据 → 每行「列名: 值」，文件名作 # 前缀', async () => {
    expect(detectSourceType('a.csv')).toBe('csv')
    const parsed = await parseDocumentBytes(
      '花名册.csv',
      csvBytes('姓名,年龄,城市\n张三,18,北京\n李四,20,上海')
    )
    expect(parsed.title).toBe('花名册.csv')
    expect(parsed.text).toContain('# 花名册.csv')
    expect(parsed.text).toContain('姓名: 张三 | 年龄: 18 | 城市: 北京')
    expect(parsed.text).toContain('姓名: 李四 | 年龄: 20 | 城市: 上海')
  })

  it('BOM 剥离、引号内逗号与双引号转义', async () => {
    const parsed = await parseDocumentBytes(
      '引号.csv',
      csvBytes('\uFEFF名称,备注\n"张三, Jr","他说 ""你好"""')
    )
    expect(parsed.text.startsWith('\uFEFF')).toBe(false)
    expect(parsed.text).toContain('名称: 张三, Jr')
    expect(parsed.text).toContain('备注: 他说 "你好"')
  })

  it('没有数据行 ⇒ 回退原始纯文本，不吞内容', async () => {
    const parsed = await parseDocumentBytes('空.csv', csvBytes('姓名,年龄\n'))
    expect(parsed.text).toBe('姓名,年龄')
  })
})

describe('XLSX 结构化解析', () => {
  it('多 sheet 各带 # 前缀，保留表头与值同行的关系', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['姓名', '年龄'], ['张三', 18], ['李四', 20]]),
      '人员'
    )
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['订单', '金额'], ['A001', 99]]),
      '订单'
    )
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const parsed = await parseDocumentBytes('数据.xlsx', new Uint8Array(buf))

    expect(parsed.text).toContain('# 人员')
    expect(parsed.text).toContain('姓名: 张三 | 年龄: 18')
    expect(parsed.text).toContain('# 订单')
    expect(parsed.text).toContain('订单: A001 | 金额: 99')
  })

  it('空 sheet 保留平铺回退，不产出空的「列名: 值」', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['只有表头']]), '空表')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const parsed = await parseDocumentBytes('空表.xlsx', new Uint8Array(buf))
    expect(parsed.text).toContain('# 空表')
    expect(parsed.text).not.toContain('undefined')
  })
})

describe('结构化分块：关键词与表头同块', () => {
  it('真实 CSV → chunkMarkdown 后「姓名」与「张三」落在同一块', async () => {
    const parsed = await parseDocumentBytes(
      '花名册.csv',
      csvBytes('姓名,年龄,城市\n张三,18,北京\n李四,20,上海\n王五,22,深圳')
    )
    const chunks = chunkMarkdown(parsed.text, { chunkSize: 80, chunkOverlap: 0 })
    const hit = chunks.find((c) => c.content.includes('张三'))
    expect(hit).toBeTruthy()
    expect(hit!.content).toContain('姓名')
    expect(hit!.content).toContain('年龄: 18')
  })

  it('真实 XLSX → 「订单」表头与「A001」同块', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['订单', '金额'], ['A001', 99]]),
      '订单'
    )
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const parsed = await parseDocumentBytes('订单.xlsx', new Uint8Array(buf))
    const chunks = chunkMarkdown(parsed.text, { chunkSize: 80, chunkOverlap: 0 })
    const hit = chunks.find((c) => c.content.includes('A001'))
    expect(hit).toBeTruthy()
    expect(hit!.content).toContain('订单')
  })

  it('chunkTableLines 按整行切：每块每行都保持完整列值关系', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      `姓名: 用户${i} | 年龄: ${20 + i} | 城市: 城市${i}`
    ).join('\n')
    const chunks = chunkTableLines(rows, { chunkSize: 60, chunkOverlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n')) {
        expect(line).toMatch(/^姓名: .+ \| 年龄: \d+ \| 城市: .+$/)
      }
    }
  })

  it('重叠按整行回退，不出现半行开头', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `编号: R${i} | 值: V${i}`).join('\n')
    const chunks = chunkTableLines(rows, { chunkSize: 40, chunkOverlap: 12 })
    for (const chunk of chunks) {
      for (const line of chunk.content.split('\n')) {
        expect(line).toMatch(/^编号: R\d+ \| 值: V\d+$/)
      }
    }
  })

  it('非表格纯文本仍走原字符分块（保留纯文本回退）', () => {
    const text = '这是一段普通正文。'.repeat(30)
    const chunks = chunkMarkdown(text, { chunkSize: 40, chunkOverlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]!.content).toContain('这是一段普通正文')
    expect(chunks[0]!.content).not.toContain('|')
  })
})
