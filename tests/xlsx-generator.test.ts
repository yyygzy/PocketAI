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

// 公式缓存值：只有公式没有缓存值时，WPS / Google Sheets 打开会先显示空白（它们不保证打开即重算）。
// 生成时自己算一份写进 v；算不了的维持现状（只写 f），并把公式文本原样保留。
// 错误格在 xlsx 里是 t="e" + 数值错误码（写字符串会被 SheetJS 写成 <v>undefined</v>），读回时 v=码、w=文案。
describe('公式缓存值', () => {
  const oneSheet = (headers: string[], rows: unknown[][]) => ({
    title: 'x',
    sheets: [{ name: 's', headers, rows }]
  })
  const sheetOf = async (headers: string[], rows: unknown[]) =>
    readBack(await buildXlsx(oneSheet(headers, rows as unknown[][]))).Sheets['s']!

  it('数值公式：缓存值落盘且与手算一致，公式文本保留', async () => {
    const ws = readBack(await buildXlsx(baseSpec())).Sheets['销售汇总']!
    // C2 = B2/$B$4 = 12000/20000；C3 = 8000/20000
    expect(ws['C2']!.t).toBe('n')
    expect(ws['C2']!.f).toBe('B2/$B$4')
    expect(ws['C2']!.v).toBeCloseTo(0.6, 10)
    expect(ws['C3']!.f).toBe('B3/$B$4')
    expect(ws['C3']!.v).toBeCloseTo(0.4, 10)
    // B4 = SUM(B2:B3)（引用的是两个普通数字格）
    expect(ws['B4']!.f).toBe('SUM(B2:B3)')
    expect(ws['B4']!.v).toBe(20000)
  })

  it('绝对引用与混合引用（$A$2 / B$2 / $A2）都能算', async () => {
    const ws = await sheetOf(['a', 'b', 'c'], [[2, 3, { formula: '$A$2*B$2*$A2' }]])
    expect(ws['C2']!.f).toBe('$A$2*B$2*$A2')
    expect(ws['C2']!.v).toBe(12)
  })

  it('除零 / 文本参与四则 / 越界 → 对应错误格', async () => {
    const ws = await sheetOf(['值', '结果'], [
      [6, { formula: 'A2/0' }],
      ['x', { formula: 'A3+1' }],
      [1, { formula: 'ZZZ9999999' }]
    ])
    expect(ws['B2']!.t).toBe('e')
    expect(ws['B2']!.v).toBe(0x07)
    expect(ws['B2']!.w).toBe('#DIV/0!')
    expect(ws['B2']!.f).toBe('A2/0')

    expect(ws['B3']!.t).toBe('e')
    expect(ws['B3']!.v).toBe(0x0f)
    expect(ws['B3']!.w).toBe('#VALUE!')
    expect(ws['B3']!.f).toBe('A3+1')

    expect(ws['B4']!.t).toBe('e')
    expect(ws['B4']!.v).toBe(0x17)
    expect(ws['B4']!.w).toBe('#REF!')
    expect(ws['B4']!.f).toBe('ZZZ9999999')
  })

  it('区域为空：AVERAGE → #DIV/0!，SUM → 0（区域里一个数字都没有）', async () => {
    const ws = await sheetOf(['值', '结果'], [
      [1, { formula: 'AVERAGE(D2:D4)' }],
      [2, { formula: 'SUM(D2:D4)' }],
      [3, { formula: 'COUNT(D2:D4)' }]
    ])
    expect(ws['B2']!.t).toBe('e')
    expect(ws['B2']!.v).toBe(0x07)
    expect(ws['B3']!.t).toBe('n')
    expect(ws['B3']!.v).toBe(0)
    expect(ws['B4']!.v).toBe(0)
  })

  it('循环引用不写缓存值，公式文本保留', async () => {
    const ws = await sheetOf(['a', 'b'], [[{ formula: 'B2' }, { formula: 'A2' }]])
    expect(ws['A2']!.f).toBe('B2')
    expect(ws['A2']!.v).toBeUndefined()
    expect(ws['B2']!.f).toBe('A2')
    expect(ws['B2']!.v).toBeUndefined()
  })

  it('跨表引用 / 不支持的函数 / 文本结果 → 不写缓存值', async () => {
    const wb = readBack(
      await buildXlsx({
        title: 'x',
        sheets: [
          {
            name: 's',
            headers: ['a', 'b'],
            rows: [
              ['文本', { formula: '明细!A1' }],
              [1, { formula: 'IF(A3>0,1,2)' }],
              [2, { formula: 'A4' }]
            ]
          },
          { name: '明细', headers: ['h'], rows: [['v']] }
        ]
      })
    )
    const ws = wb.Sheets['s']!
    expect(ws['B2']!.f).toBe('明细!A1')
    expect(ws['B2']!.v).toBeUndefined()
    expect(ws['B3']!.f).toBe('IF(A3>0,1,2)')
    expect(ws['B3']!.v).toBeUndefined()
    // A4 是数字 2，公式 =A4 结果也是数字，能算
    expect(ws['B4']!.v).toBe(2)
    // 文本格引用：结果是文本，不缓存
    const text = await sheetOf(['a', 'b'], [['文本', { formula: 'A2' }]])
    expect(text['B2']!.f).toBe('A2')
    expect(text['B2']!.v).toBeUndefined()
  })

  it('链式引用：公式引用公式也能算出缓存值', async () => {
    const ws = await sheetOf(['a', 'b'], [
      [1, { formula: 'A2*2' }],
      [3, { formula: 'B2+A3' }]
    ])
    expect(ws['B2']!.v).toBe(2)
    expect(ws['B3']!.v).toBe(5)
  })
})
