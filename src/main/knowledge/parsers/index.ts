// 文档解析：按 sourceType 分派到对应解析器，统一返回纯文本
// 支持格式：pdf / docx / xlsx / html / url / txt / md（image 由 OCR 链路处理，见 ../ocr.ts）
import fs from 'node:fs'
import path from 'node:path'
import { safeFetch } from '../../net/safe-fetch'
import type { KbSourceType } from '../../../shared/types'

export interface ParseResult {
  text: string
  title: string
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.log', '.json'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

export function detectSourceType(filePathOrUrl: string): KbSourceType {
  const lower = filePathOrUrl.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return 'url'
  }
  const ext = path.extname(lower)
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx'
  if (ext === '.csv') return 'csv'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return ext === '.md' || ext === '.markdown' ? 'md' : 'txt'
  return 'txt'
}

/** 主入口：按类型解析 */
export async function parseDocument(
  source: string,
  sourceType: KbSourceType
): Promise<ParseResult> {
  switch (sourceType) {
    case 'pdf':
      return parsePdf(source)
    case 'docx':
      return parseDocx(source)
    case 'xlsx':
      return parseXlsx(source)
    case 'csv':
      return parseCsv(source)
    case 'html':
      return parseHtml(fs.readFileSync(source, 'utf8'), path.basename(source))
    case 'url':
      return parseUrl(source)
    case 'image':
      // 防御：图片不在此解析（default 分支会把二进制当文本读出乱码），必须走 OCR 链路
      throw new Error('图片文档需通过 OCR 链路解析（知识库需配置 OCR 视觉模型）')
    case 'md':
    case 'txt':
    default:
      return parseText(source)
  }
}

/** 纯文本 / Markdown */
async function parseText(filePath: string): Promise<ParseResult> {
  const text = fs.readFileSync(filePath, 'utf8')
  return { text, title: path.basename(filePath) }
}

/** PDF → 文本（pdf-parse v2）；知识库走文件路径，聊天附件走同一份字节实现 */
async function parsePdfBytes(data: Uint8Array, fallbackTitle: string): Promise<ParseResult> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data })
  try {
    const textResult = await parser.getText()
    let title = fallbackTitle
    try {
      const info = await parser.getInfo() as { info?: { Title?: unknown } } | null | undefined
      const t = info?.info?.Title
      if (typeof t === 'string' && t) title = t
    } catch {
      // 元信息读取失败不影响正文
    }
    return { text: (textResult.text ?? '').trim(), title }
  } finally {
    await parser.destroy()
  }
}

async function parsePdf(filePath: string): Promise<ParseResult> {
  return parsePdfBytes(new Uint8Array(fs.readFileSync(filePath)), path.basename(filePath))
}

/** DOCX → 文本（mammoth 转 HTML 再去标签）；buffer 版供聊天附件复用 */
async function parseDocxBytes(bytes: Uint8Array, fallbackTitle: string): Promise<ParseResult> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return { text: (result.value ?? '').trim(), title: fallbackTitle }
}

async function parseDocx(filePath: string): Promise<ParseResult> {
  return parseDocxBytes(fs.readFileSync(filePath), path.basename(filePath))
}

/** XLSX/XLS → 行式「列名: 值」文本（每 sheet 带 # 标题）；字节版供聊天附件复用 */
async function parseXlsxBytes(bytes: Uint8Array, fallbackTitle: string): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(Buffer.from(bytes), { type: 'buffer' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false
    }) as string[][]
    // 无表头/无数据行 ⇒ 保留平铺 CSV 纯文本回退，不让结构化格式吞掉内容
    parts.push(rowsToStructuredText(rows, name) ?? `# ${name}\n${XLSX.utils.sheet_to_csv(sheet)}`)
  }
  return { text: parts.join('\n\n'), title: fallbackTitle }
}

async function parseXlsx(filePath: string): Promise<ParseResult> {
  return parseXlsxBytes(fs.readFileSync(filePath), path.basename(filePath))
}

/**
 * CSV → 行式「列名: 值」文本（文件名作 # 标题，让 chunkMarkdown 的标题节机制带上来源）。
 * 只做 UTF-8 + BOM 剥离 + 引号转义，不猜 GBK：读不出的字节宁可交给用户另存为 UTF-8。
 */
async function parseCsvBytes(bytes: Uint8Array, fallbackTitle: string): Promise<ParseResult> {
  const raw = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')
  return {
    text: rowsToStructuredText(parseCsvRows(raw), fallbackTitle) ?? raw.trim(),
    title: fallbackTitle
  }
}

async function parseCsv(filePath: string): Promise<ParseResult> {
  return parseCsvBytes(new Uint8Array(fs.readFileSync(filePath)), path.basename(filePath))
}

/** 支持引号包裹、引号内逗号与双引号转义的 CSV 行解析；空行丢弃 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c ?? '').trim()))
}

/**
 * 表头 + 数据行 → 每行「列名: 值 | 列名: 值」。
 * 表头重复进每个数据行，保证「关键词 + 表头」落在同一分块；无有效数据行时返回 null 走纯文本回退。
 */
function rowsToStructuredText(rows: string[][], label?: string): string | null {
  if (rows.length < 2) return null
  const header = (rows[0] ?? []).map((c) => String(c ?? '').trim())
  const lines: string[] = []
  if (label) lines.push(`# ${label}`)
  let dataRows = 0
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] ?? []
    const pairs: string[] = []
    for (let j = 0; j < header.length; j++) {
      const key = header[j]!
      if (!key) continue
      const val = String(cells[j] ?? '').trim()
      if (val) pairs.push(`${key}: ${val}`)
    }
    if (pairs.length) {
      lines.push(pairs.join(' | '))
      dataRows++
    }
  }
  return dataRows > 0 ? lines.join('\n') : null
}

/**
 * 聊天附件用：不落临时文件，直接按文件名判定类型并从字节提取纯文本。
 * 图片/URL 不走这里（图片直接作为视觉附件，URL 不是本地文件）。
 */
export async function parseDocumentBytes(fileName: string, bytes: Uint8Array): Promise<ParseResult> {
  const type = detectSourceType(fileName)
  const title = path.basename(fileName)
  if (type === 'image' || type === 'url') throw new Error('该格式不支持作为聊天文档附件解析')
  if (type === 'pdf') return parsePdfBytes(bytes, title)
  if (type === 'docx') return parseDocxBytes(bytes, title)
  if (type === 'xlsx') return parseXlsxBytes(bytes, title)
  if (type === 'csv') return parseCsvBytes(bytes, title)
  const text = Buffer.from(bytes).toString('utf8')
  if (type === 'html') return parseHtml(text, title)
  return { text, title }
}

/** HTML → 文本（cheerio 去标签） */
async function parseHtml(html: string, fallbackTitle: string): Promise<ParseResult> {
  const cheerio = await import('cheerio')
  const $ = cheerio.load(html)
  // 移除脚本/样式/导航等噪声
  $('script,style,nav,footer,header,aside').remove()
  const title = $('title').text().trim() || $('h1').first().text().trim() || fallbackTitle
  const text = $('body').text().replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, title }
}

/** URL → 抓取 HTML → 文本 */
async function parseUrl(url: string): Promise<ParseResult> {
  // 知识库导入 URL 可由 Agent/外部内容触发，必须走 safeFetch：
  // 拦截内网/环回/云元数据地址（SSRF）、手动逐跳跟随重定向、限制体积与时长
  const res = await safeFetch(url, {
    timeoutMs: 30_000,
    maxBytes: 10 * 1024 * 1024,
    headers: { 'User-Agent': 'PocketAI/0.1 (knowledge-base)' }
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`抓取 URL 失败: HTTP ${res.status}`)
  return parseHtml(res.body.toString('utf8'), res.finalUrl)
}
