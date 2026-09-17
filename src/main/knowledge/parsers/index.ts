// 文档解析：按 sourceType 分派到对应解析器，统一返回纯文本
// 支持格式：pdf / docx / xlsx / html / url / txt / md
import fs from 'node:fs'
import path from 'node:path'
import type { KbSourceType } from '../../../shared/types'

export interface ParseResult {
  text: string
  title: string
}

const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json'])

export function detectSourceType(filePathOrUrl: string): KbSourceType {
  const lower = filePathOrUrl.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return 'url'
  }
  const ext = path.extname(lower)
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx'
  if (ext === '.html' || ext === '.htm') return 'html'
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
    case 'html':
      return parseHtml(fs.readFileSync(source, 'utf8'), path.basename(source))
    case 'url':
      return parseUrl(source)
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

/** PDF → 文本（pdf-parse v2） */
async function parsePdf(filePath: string): Promise<ParseResult> {
  const { PDFParse } = await import('pdf-parse')
  const data = new Uint8Array(fs.readFileSync(filePath))
  const parser = new PDFParse({ data })
  try {
    const textResult = await parser.getText()
    let title = path.basename(filePath)
    try {
      const info = await parser.getInfo()
      const t = (info as any)?.info?.Title
      if (t) title = t
    } catch {
      // 元信息读取失败不影响正文
    }
    return { text: (textResult.text ?? '').trim(), title }
  } finally {
    await parser.destroy()
  }
}

/** DOCX → 文本（mammoth 转 HTML 再去标签） */
async function parseDocx(filePath: string): Promise<ParseResult> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return {
    text: (result.value ?? '').trim(),
    title: path.basename(filePath)
  }
}

/** XLSX → 文本（每个 sheet 转 CSV 拼接） */
async function parseXlsx(filePath: string): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const wb = XLSX.readFile(filePath)
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`# ${name}\n${csv}`)
  }
  return { text: parts.join('\n\n'), title: path.basename(filePath) }
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
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PocketAI/0.1 (knowledge-base)' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`抓取 URL 失败: HTTP ${res.status}`)
  const html = await res.text()
  return parseHtml(html, url)
}
