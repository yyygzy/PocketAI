// XLSX 生成器：真生成 + SheetJS 读回 + 上限闸门（超限必须拒绝，不静默截断）
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildXlsx } from '../src/main/artifacts/generators/xlsx'

const readBack = (buf: Buffer) =>
  XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true, cellStyles: true })

const baseSpec = () => ({
  title: '2026 年第四季度数据',
  sheets: [
    {
      name: '销售汇总',
      headers: ['区域', '金额', '占比'],
      rows: [
        ['华东', 12000, { formula: 'B2/$B$4' }],
        ['华南', 8000, { formula: 'B3/$B$4' }],
        ['合计', { formula: 'SUM(B2:B3)' }, 1]
      ],
      colWidths: [16, 12, 10],
      numberFormats: ['@', '#,##0', '0.0%'],
      merges: [{ r1: 0, c1: 0, r2: 0, c2: 1 }]
    },
    {
      name: '明细',
      headers: ['日期', '说明'],
      rows: [['2026-10-01', '首单']]
    }
  ]
})

describe('buildXlsx', () => {
  it('生成合法 xlsx：多 sheet / 值 / 列宽 / 合并 / 数字格式 / 公式都在', async () => {
    const buf = await buildXlsx(baseSpec())
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')

    const wb = readBack(buf)
    expect(wb.SheetNames).toEqual(['销售汇总', '明细'])
    const ws = wb.Sheets['销售汇总']!
    expect(ws['A1']?.v).toBe('区域')
    expect(ws['A2']?.v).toBe('华东')
    expect(ws['B2']?.v).toBe(12000)
    expect(ws['B2']?.z).toBe('#,##0')
    expect(ws['C2']?.f).toBe('B2/$B$4')
    expect(ws['B4']?.f).toBe('SUM(B2:B3)')
    expect(ws['!cols']?.[0]?.wch).toBe(16)
    expect(ws['!merges']).toEqual([{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }])
  })

  it('工作表名去非法字符；超过 31 字符直接拒绝', async () => {
    const wb = readBack(
      await buildXlsx({
        title: 'x',
        sheets: [
          {
            name: 'a/b:c*?[]' + '名'.repeat(3),
            headers: ['h'],
            rows: [['v']]
          }
        ]
      })
    )
    expect(wb.SheetNames).toHaveLength(1)
    expect(wb.SheetNames[0]).not.toMatch(/[\\/*?:[\]]/)
    expect(wb.SheetNames[0]).toBe('abc' + '名'.repeat(3))

    await expect(
      buildXlsx({ title: 'x', sheets: [{ name: '名'.repeat(32), headers: ['h'], rows: [] }] })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
  })

  it('超限直接拒绝：空表 / 11 张 / 31 列 / 201 行 / 单元格超字 / 行宽不一致', async () => {
    const one = { name: 's', headers: ['h'], rows: [['v']] }
    await expect(buildXlsx({ title: 'x', sheets: [] })).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildXlsx({ title: 'x', sheets: Array.from({ length: 11 }, (_, i) => ({ ...one, name: `s${i}` })) })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, headers: Array.from({ length: 31 }, (_, i) => `h${i}`), rows: [] }] })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildXlsx({
        title: 'x',
        sheets: [{ ...one, rows: Array.from({ length: 201 }, () => ['v']) }]
      })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, rows: [['长'.repeat(201)]] }] })
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, headers: ['a', 'b'], rows: [['1']] }] })
    ).rejects.toThrow(/列数/)
  })

  it('重名 / 列宽或格式数量不符 / 合并越界或重叠 → 拒绝', async () => {
    const one = { name: 's', headers: ['a', 'b'], rows: [['1', '2']] }
    await expect(
      buildXlsx({ title: 'x', sheets: [one, { ...one, name: 'S' }] })
    ).rejects.toThrow(/重复/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, colWidths: [10] }] })
    ).rejects.toThrow(/列宽/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, numberFormats: ['0.00'] }] })
    ).rejects.toThrow(/数字格式/)
    await expect(
      buildXlsx({ title: 'x', sheets: [{ ...one, merges: [{ r1: 0, c1: 0, r2: 5, c2: 1 }] }] })
    ).rejects.toThrow(/超出/)
    await expect(
      buildXlsx({
        title: 'x',
        sheets: [
          {
            ...one,
            merges: [
              { r1: 0, c1: 0, r2: 1, c2: 1 },
              { r1: 0, c1: 1, r2: 1, c2: 1 }
            ]
          }
        ]
      })
    ).rejects.toThrow(/重叠/)
  })

  it('全簿单元格总数超 2 万 → 拒绝并提示拆分', async () => {
    const headers = Array.from({ length: 30 }, (_, i) => `h${i}`)
    const rows = Array.from({ length: 200 }, () => headers.map(() => 'v'))
    await expect(
      buildXlsx({
        title: 'x',
        sheets: [1, 2, 3, 4].map((i) => ({ name: `s${i}`, headers, rows }))
      })
    ).rejects.toThrow(/拆分/)
  })
})
