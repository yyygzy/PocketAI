// XLSX 生成器：结构化 spec → .xlsx 字节（纯函数，不依赖 electron / 数据库，便于单测）
//
// SheetJS CE（0.20.3）的能力边界（许可证事实，不是实现取舍）：
//  · 能写：多工作表、列宽、合并区域、数字格式、公式字符串；
//  · 不能写：单元格字体 / 底色 / 边框等样式（这些属 Pro）。
// 所以 v1 明确「不做单元格样式」，界面与模型说明都如实写，不假装能出报表级样式。
//
// 与 PPTX/DOCX 同一口径：超限在 schema / 生成前校验里直接拒绝（ARTIFACT_INVALID_SPEC），
// 不静默截断、不指望 Excel 打开后再兜底。
import * as XLSX from 'xlsx'
import { z } from 'zod'

/** 工作表数量上限 */
const MAX_SHEETS = 10
/** 每张表列数上限（含表头） */
const MAX_COLS = 30
/** 每张表数据行上限（不含表头） */
const MAX_ROWS = 200
/** 单元格字符上限（数字与公式按原始字符串长度计） */
const MAX_CELL_CHARS = 200
/** 表头字符上限 */
const MAX_HEADER_CHARS = 80
/** 每张表合并区域数量上限 */
const MAX_MERGES = 20
/** 全簿单元格总数上限（含表头），防止模型一次塞爆内存 */
const MAX_TOTAL_CELLS = 20_000
/** 生成文件字节上限：xlsx 是压缩包，5MB 已远超正常表格 */
const MAX_BYTES = 5 * 1024 * 1024
/** 列宽范围（Excel 字符宽） */
const MIN_COL_WIDTH = 5
const MAX_COL_WIDTH = 100
/** 数字格式串长度上限 */
const MAX_FORMAT_CHARS = 30

const cellSchema = z.union([
  z.string().max(MAX_CELL_CHARS),
  z.number().finite(),
  z.strictObject({
    /** Excel 公式（可带或不带前导 =）；结果由 Excel 打开时重算 */
    formula: z.string().trim().min(1).max(MAX_CELL_CHARS)
  })
])

const mergeSchema = z
  .strictObject({
    r1: z.number().int().min(0),
    c1: z.number().int().min(0),
    r2: z.number().int().min(0),
    c2: z.number().int().min(0)
  })
  .refine((m) => m.r2 >= m.r1 && m.c2 >= m.c1, { message: '合并区域终点必须不小于起点' })
  .refine((m) => m.r2 > m.r1 || m.c2 > m.c1, { message: '合并区域至少要有两个单元格' })

const sheetSchema = z
  .strictObject({
    /** 工作表名（≤31 字符，非法字符会被移除） */
    name: z.string().trim().min(1).max(31),
    headers: z.array(z.string().trim().min(1).max(MAX_HEADER_CHARS)).min(1).max(MAX_COLS),
    rows: z
      .array(z.array(cellSchema).min(1).max(MAX_COLS))
      .max(MAX_ROWS)
      .refine((rows) => rows.every((r) => r.length === rows[0]?.length), {
        message: '每一行的列数必须一致'
      }),
    /** 列宽（可选，长度必须与表头一致） */
    colWidths: z
      .array(z.number().int().min(MIN_COL_WIDTH).max(MAX_COL_WIDTH))
      .min(1)
      .max(MAX_COLS)
      .optional(),
    /** 每列数字格式（可选，长度必须与表头一致；空串表示该列不设格式） */
    numberFormats: z.array(z.string().trim().max(MAX_FORMAT_CHARS)).min(1).max(MAX_COLS).optional(),
    /** 合并区域（可选，零基坐标，表头行 = 0） */
    merges: z.array(mergeSchema).max(MAX_MERGES).optional()
  })
  .superRefine((s, ctx) => {
    if (s.rows.some((r) => r.length !== s.headers.length)) {
      ctx.addIssue({ code: 'custom', path: ['rows'], message: '每一行的列数必须与表头一致' })
    }
    if (s.colWidths && s.colWidths.length !== s.headers.length) {
      ctx.addIssue({ code: 'custom', path: ['colWidths'], message: '列宽数量必须与表头列数一致' })
    }
    if (s.numberFormats && s.numberFormats.length !== s.headers.length) {
      ctx.addIssue({ code: 'custom', path: ['numberFormats'], message: '数字格式数量必须与表头列数一致' })
    }
    const lastRow = s.rows.length
    const lastCol = s.headers.length - 1
    for (const [i, m] of (s.merges ?? []).entries()) {
      if (m.r2 > lastRow || m.c2 > lastCol) {
        ctx.addIssue({ code: 'custom', path: ['merges', i], message: '合并区域超出表格范围' })
      }
    }
    // 合并区域互相重叠会让 Excel 报「需要修复」，生成前就拒绝
    const ms = s.merges ?? []
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i]!
        const b = ms[j]!
        if (a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2) {
          ctx.addIssue({ code: 'custom', path: ['merges', i], message: '合并区域之间不能重叠' })
        }
      }
    }
  })

export const xlsxSpecSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  sheets: z.array(sheetSchema).min(1).max(MAX_SHEETS)
})

export type XlsxSpec = z.infer<typeof xlsxSpecSchema>

/** zod 错误 → 模型能看懂的单行定位（与 PPTX/DOCX 生成器同一格式） */
export function formatSpecError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`)
      .join('；')
  }
  return err instanceof Error ? err.message : String(err)
}

/** Excel 工作表名：去掉非法字符与首尾单引号，按码点截 31，空名拒绝 */
function sanitizeSheetName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/*?:[\]]/g, '')
    .replace(/^'+|'+$/g, '')
    .trim()
  const clipped = Array.from(cleaned).slice(0, 31).join('')
  if (!clipped) throw new Error('[ARTIFACT_INVALID_SPEC] 工作表名去掉非法字符后为空')
  return clipped
}

function formulaText(raw: string): string {
  return raw.trim().replace(/^=/, '')
}

function countCells(spec: XlsxSpec): number {
  let n = 0
  for (const s of spec.sheets) n += s.headers.length + s.rows.length * s.headers.length
  return n
}

function buildSheet(sheet: XlsxSpec['sheets'][number]): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {}
  const cols = sheet.headers.length
  const rows = [sheet.headers, ...sheet.rows]
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = rows[r]![c]!
      const addr = XLSX.utils.encode_cell({ r, c })
      const fmt = sheet.numberFormats?.[c]?.trim() || undefined
      if (typeof cell === 'object') {
        ws[addr] = { t: 'n', f: formulaText(cell.formula), ...(fmt ? { z: fmt } : {}) }
      } else if (typeof cell === 'number') {
        ws[addr] = { t: 'n', v: cell, ...(fmt ? { z: fmt } : {}) }
      } else {
        ws[addr] = { t: 's', v: cell }
      }
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length - 1, c: cols - 1 }
  })
  if (sheet.colWidths) ws['!cols'] = sheet.colWidths.map((w) => ({ wch: w }))
  if (sheet.merges?.length) {
    ws['!merges'] = sheet.merges.map((m) => ({ s: { r: m.r1, c: m.c1 }, e: { r: m.r2, c: m.c2 } }))
  }
  return ws
}

export async function buildXlsx(spec: unknown): Promise<Buffer> {
  const parsed = xlsxSpecSchema.safeParse(spec)
  if (!parsed.success) {
    throw new Error(`[ARTIFACT_INVALID_SPEC] ${formatSpecError(parsed.error)}`)
  }
  const data = parsed.data
  const total = countCells(data)
  if (total > MAX_TOTAL_CELLS) {
    throw new Error(
      `[ARTIFACT_INVALID_SPEC] 全簿合计 ${total} 个单元格，超过 ${MAX_TOTAL_CELLS} 上限；请拆分成多份表格`
    )
  }

  const names = new Set<string>()
  for (const s of data.sheets) {
    const name = sanitizeSheetName(s.name)
    const key = name.toLowerCase()
    if (names.has(key)) {
      throw new Error(`[ARTIFACT_INVALID_SPEC] 工作表名重复（不区分大小写）：${name}`)
    }
    names.add(key)
  }

  const wb = XLSX.utils.book_new()
  // 公式只写 <f>、不写缓存值：Excel 打开时会把无缓存值的公式当作待计算
  for (const s of data.sheets) {
    XLSX.utils.book_append_sheet(wb, buildSheet(s), sanitizeSheetName(s.name))
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', compression: true }) as Buffer
  if (buf.length > MAX_BYTES) {
    throw new Error(
      `[ARTIFACT_INVALID_SPEC] 生成的表格 ${Math.ceil(buf.length / 1024 / 1024)}MB，超过 ${MAX_BYTES / 1024 / 1024}MB 上限`
    )
  }
  return buf
}
