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
    /** Excel 公式（可带或不带前导 =）；生成时尽量带缓存值，Excel 打开仍会重算 */
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

// ---------- 公式求值（只为我们能完全吃透的子集写缓存值） ----------
//
// 为什么自己算：只有 <f> 没有 <v> 时，Excel 会重算，但 WPS / Google Sheets 会先显示空白
// （它们不保证打开即重算），对非技术用户就是"表格是空的"。缓存值只是"开机显示"，公式仍在，
// Excel 打开依旧重算。
//
// 边界（刻意做小，宁可不算也不写错值）：
//  · 支持：数字、单元格引用（A1 / $A$1 / A$1 / $A1）、区域 A1:B4、
//    四则运算与括号、一元正负、SUM / AVERAGE / MIN / MAX / COUNT；
//  · 不支持（**不写缓存值**，保持现状）：跨表引用（Sheet1!A1）、其它函数（VLOOKUP/IF…）、
//    文本拼接、百分比字面量、比较运算；结果是文本的公式（=A1 指向文本格）同样不缓存；
//  · 循环引用也不写缓存值：Excel 自己会弹循环引用警告，我们编一个数反而更误导。
//
// 错误语义对齐 Excel：
//  · 除以 0 → #DIV/0!；文本参与四则运算 → #VALUE!；地址超出 Excel 网格 → #REF!；
//  · 区域聚合（SUM/AVERAGE/MIN/MAX/COUNT）只统计数字，文本与空格**跳过**（Excel 的区间语义）；
//  · AVERAGE / MIN / MAX 的区域里一个数字都没有 → #DIV/0!；SUM/COUNT 则为 0。
const EXCEL_MAX_ROW = 1_048_576
const EXCEL_MAX_COL = 16_384

type ErrCode = '#DIV/0!' | '#VALUE!' | '#REF!'
/** SheetJS 写错误格必须给**数值错误码**（写字符串会被写成 `<v>undefined</v>`），读回时 v=码、w=文案 */
const ERR_CODE: Record<ErrCode, number> = { '#DIV/0!': 0x07, '#VALUE!': 0x0f, '#REF!': 0x17 }
type PVal =
  | { k: 'n'; n: number }
  | { k: 'e'; e: ErrCode }
  /** 文本结果：不写缓存值（文本型公式不在本子集内） */
  | { k: 't'; s: string }
  | { k: 'skip' }
  /** 区域：展开成逐格结果（数字 / 错误 / 跳过） */
  | { k: 'r'; cells: PVal[] }

const SKIP: PVal = { k: 'skip' }
const OUT_OF_RANGE = Symbol('out-of-range')
type Lookup = number | string | { formula: string } | typeof OUT_OF_RANGE | undefined

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 数值化：数字直接用；数字样子的文本按数字（Excel 在四则里会这么干）；其它 → null */
function asNumber(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = v.trim()
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

class SheetEvaluator {
  private memo = new Map<string, PVal>()
  private visiting = new Set<string>()

  constructor(private grid: Lookup[][]) {}

  /** 顶层：解析并求值；解析不了/循环引用 → skip（调用方据此不写缓存值） */
  evaluate(formula: string): PVal {
    const p = new FormulaParser(formula, this)
    const v = p.parse()
    // 顶层只缓存数字与错误：文本结果（=A1 指向文本格）与整体区域（=A1:B2）都不缓存
    return v.k === 't' || v.k === 'r' ? SKIP : v
  }

  cell(r: number, c: number): PVal {
    if (r < 0 || c < 0 || r >= EXCEL_MAX_ROW || c >= EXCEL_MAX_COL) return { k: 'e', e: '#REF!' }
    const key = `${r}:${c}`
    const hit = this.memo.get(key)
    if (hit) return hit
    const raw = this.grid[r]?.[c]
    if (raw === OUT_OF_RANGE) return { k: 'e', e: '#REF!' }
    if (raw === undefined) return { k: 'n', n: 0 } // 空格在四则里按 0
    if (typeof raw === 'number') return { k: 'n', n: raw }
    if (typeof raw === 'string') {
      const n = asNumber(raw)
      // 文本格单独引用是文本结果（不缓存）；要参与四则时由 arith 转成 #VALUE!
      return n === null ? { k: 't', s: raw } : { k: 'n', n }
    }
    // 公式格：递归求值；循环引用一律 skip
    if (this.visiting.has(key)) return SKIP
    this.visiting.add(key)
    const v = this.evaluate(formulaText(raw.formula))
    this.visiting.delete(key)
    if (v.k === 'r') return SKIP
    this.memo.set(key, v)
    return v
  }

  /** 区域里的逐格结果：文本/空按"跳过"处理（不参与聚合，也不报错） */
  rangeCells(r1: number, c1: number, r2: number, c2: number): PVal {
    const out: PVal[] = []
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        if (r >= EXCEL_MAX_ROW || c >= EXCEL_MAX_COL) return { k: 'e', e: '#REF!' }
        const raw = this.grid[r]?.[c]
        if (raw === OUT_OF_RANGE) return { k: 'e', e: '#REF!' }
        if (raw === undefined) continue
        if (typeof raw === 'number') {
          out.push({ k: 'n', n: raw })
        } else if (typeof raw === 'string') {
          const n = asNumber(raw)
          if (n !== null) out.push({ k: 'n', n })
        } else if (raw.formula) {
          const v = this.cell(r, c)
          // 区间聚合只吃数字与错误；文本结果按 Excel 语义忽略
          if (v.k === 'n' || v.k === 'e') out.push(v)
        }
      }
    }
    return { k: 'r', cells: out }
  }
}

class FormulaParser {
  private i = 0
  constructor(
    private readonly src: string,
    private readonly ev: SheetEvaluator
  ) {}

  parse(): PVal {
    const v = this.expr()
    this.ws()
    if (this.i < this.src.length) return SKIP // 有没吃掉的残留（比如 Sheet1!A1 的 '!'）→ 不支持
    return v
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++
  }

  private eat(ch: string): boolean {
    this.ws()
    if (this.src[this.i] !== ch) return false
    this.i++
    return true
  }

  private expr(): PVal {
    let left = this.term()
    for (;;) {
      this.ws()
      const op = this.src[this.i]
      if (op !== '+' && op !== '-') return left
      this.i++
      const right = this.term()
      left = this.arith(left, right, op)
    }
  }

  private term(): PVal {
    let left = this.factor()
    for (;;) {
      this.ws()
      const op = this.src[this.i]
      if (op !== '*' && op !== '/') return left
      this.i++
      const right = this.factor()
      left = this.arith(left, right, op)
    }
  }

  private arith(a: PVal, b: PVal, op: string): PVal {
    if (a.k === 'skip' || b.k === 'skip') return SKIP
    if (a.k === 'e') return a
    if (b.k === 'e') return b
    if (a.k !== 'n' || b.k !== 'n') return { k: 'e', e: '#VALUE!' }
    if (op === '/') {
      if (b.n === 0) return { k: 'e', e: '#DIV/0!' }
      return { k: 'n', n: a.n / b.n }
    }
    if (op === '*') return { k: 'n', n: a.n * b.n }
    return { k: 'n', n: op === '+' ? a.n + b.n : a.n - b.n }
  }

  private factor(): PVal {
    this.ws()
    if (this.eat('-')) {
      const v = this.factor()
      if (v.k === 'n') return { k: 'n', n: -v.n }
      if (v.k === 't') return { k: 'e', e: '#VALUE!' }
      return v
    }
    if (this.eat('+')) return this.factor()
    return this.primary()
  }

  private primary(): PVal {
    this.ws()
    if (this.eat('(')) {
      const v = this.expr()
      if (!this.eat(')')) return SKIP
      return v
    }
    const ch = this.src[this.i]
    if (ch === undefined) return SKIP

    if (ch >= '0' && ch <= '9') {
      const start = this.i
      while (this.i < this.src.length && /[0-9.]/.test(this.src[this.i]!)) this.i++
      const n = Number(this.src.slice(start, this.i))
      return Number.isFinite(n) ? { k: 'n', n } : SKIP
    }

    const rest = this.src.slice(this.i)
    const fn = /^([A-Za-z]+)\s*\(/.exec(rest)
    if (fn) {
      this.i += fn[0].length
      return this.call(fn[1]!.toUpperCase())
    }

    const ref = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})/.exec(rest)
    if (ref) {
      this.i += ref[0].length
      const start = this.cellRef(ref[1]!, ref[2]!)
      if (start.k === 'e') return start
      if (this.eat(':')) {
        const rest2 = this.src.slice(this.i)
        const ref2 = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})/.exec(rest2)
        if (!ref2) return SKIP
        this.i += ref2[0].length
        const end = this.cellRef(ref2[1]!, ref2[2]!)
        if (end.k === 'e') return end
        return this.ev.rangeCells(start.r, start.c, end.r, end.c)
      }
      return this.ev.cell(start.r, start.c)
    }

    return SKIP
  }

  /** 引用解析：去掉 `$`，返回零基坐标；地址越出 Excel 网格 → #REF! */
  private cellRef(letters: string, digits: string): { k: 'ref'; r: number; c: number } | { k: 'e'; e: ErrCode } {
    const r = Number(digits) - 1
    const c = colIndex(letters)
    if (c < 0 || c >= EXCEL_MAX_COL || r < 0 || r >= EXCEL_MAX_ROW) return { k: 'e', e: '#REF!' }
    return { k: 'ref', r, c }
  }

  private call(name: string): PVal {
    const args: PVal[] = []
    this.ws()
    if (!this.eat(')')) {
      for (;;) {
        args.push(this.expr())
        if (this.eat(',')) continue
        if (this.eat(')')) break
        return SKIP
      }
    }
    return applyFunction(name, args)
  }
}

/** 函数语义：区间里只统计数字（文本/空格跳过）；单个参数若是文本格则会得到 #VALUE! */
function applyFunction(name: string, args: PVal[]): PVal {
  if (!['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'].includes(name)) return SKIP
  const nums: number[] = []
  for (const a of args) {
    if (a.k === 'skip') return SKIP
    if (a.k === 'e') return a
    if (a.k === 't') continue // 文本参数按 Excel 语义忽略（不参与聚合、也不报错）
    if (a.k === 'n') {
      nums.push(a.n)
      continue
    }
    for (const cell of a.cells) {
      if (cell.k === 'skip') return SKIP
      if (cell.k === 'e') return cell
      if (cell.k === 'n') nums.push(cell.n)
    }
  }
  if (name === 'COUNT') return { k: 'n', n: nums.length }
  if (name === 'SUM') return { k: 'n', n: nums.reduce((s, n) => s + n, 0) }
  if (nums.length === 0) return { k: 'e', e: '#DIV/0!' }
  if (name === 'AVERAGE') return { k: 'n', n: nums.reduce((s, n) => s + n, 0) / nums.length }
  return { k: 'n', n: name === 'MIN' ? Math.min(...nums) : Math.max(...nums) }
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
  const ev = new SheetEvaluator(rows)
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = rows[r]![c]!
      const addr = XLSX.utils.encode_cell({ r, c })
      const fmt = sheet.numberFormats?.[c]?.trim() || undefined
      if (typeof cell === 'object') {
        const f = formulaText(cell.formula)
        const v = ev.evaluate(f)
        if (v.k === 'n') {
          // 公式 + 缓存值：WPS / Google Sheets 打开即有内容，Excel 仍会重算
          ws[addr] = { t: 'n', f, v: v.n, ...(fmt ? { z: fmt } : {}) }
        } else if (v.k === 'e') {
          // SheetJS 的错误格只认数值错误码；字符串会被写成 <v>undefined</v>
          ws[addr] = { t: 'e', f, v: ERR_CODE[v.e], ...(fmt ? { z: fmt } : {}) }
        } else {
          // 解析不了 / 不支持 / 循环引用：维持现状，只写公式不写缓存值
          ws[addr] = { t: 'n', f, ...(fmt ? { z: fmt } : {}) }
        }
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
  // 公式格会尽量带上自己算出的缓存值（见文件头的求值边界）；算不了的只写公式，交给 Excel 重算
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
