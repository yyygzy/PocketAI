// 内置工具（M3.3 / M4.3）
// v1 实现：time.now / calculator / web.fetch
// 其它（web.search / file.read / file.write / calendar.read）保留 schema 但执行时报"未配置"，
// 留作后续扩展点（搜索 API、文件授权目录、ICS 解析等）。

import type { ToolSchema } from '../../shared/types'

export interface BuiltinTool {
  schema: ToolSchema
  execute(args: Record<string, unknown>): Promise<string>
}

const timeNowTool: BuiltinTool = {
  schema: {
    id: 'time.now',
    name: 'time_now',
    description: '获取当前本地时间（ISO 8601 与人类可读格式）。无参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    source: 'builtin',
    permission: 'auto'
  },
  async execute() {
    const now = new Date()
    return JSON.stringify({
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN', { hour12: false }),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  }
}

const calculatorTool: BuiltinTool = {
  schema: {
    id: 'calculator',
    name: 'calculator',
    description:
      '数学表达式求值。仅支持数字与 + - * / ** % () 以及函数：abs, sqrt, min, max, sin, cos, tan, ln, log10, exp, round, floor, ceil。参数：expression (string)。',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，如 2+3*4 或 sqrt(16)+max(1,2)' }
      },
      required: ['expression'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args) {
    const expr = String(args?.expression ?? '').trim()
    if (!expr) throw new Error('expression 不能为空')
    return JSON.stringify({ expression: expr, result: safeMathEval(expr) })
  }
}

const webFetchTool: BuiltinTool = {
  schema: {
    id: 'web.fetch',
    name: 'web_fetch',
    description:
      '抓取指定 URL 的网页正文（剥除导航/脚本/样式，保留主要文本内容）。参数：url (string)，maxChars (number, 可选, 默认 8000)。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的 URL（http/https）' },
        maxChars: { type: 'number', description: '返回文本最大字符数，默认 8000' }
      },
      required: ['url'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args) {
    const url = String(args?.url ?? '').trim()
    const maxChars = Number(args?.maxChars) > 0 ? Number(args.maxChars) : 8000
    if (!url) throw new Error('url 不能为空')
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'PocketAI/0.1 (+local-first AI workstation)' },
        redirect: 'follow'
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      const text = extractReadableText(html, maxChars)
      const title = extractTitle(html)
      return JSON.stringify({ url, title, content: text })
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---- 占位工具：保留 schema，执行时报"未配置" ----
const placeholder = (
  id: string,
  name: string,
  description: string,
  parameters: Record<string, unknown>
): BuiltinTool => ({
  schema: { id, name, description, parameters, source: 'builtin', permission: 'confirm' },
  async execute() {
    throw new Error(`工具 ${name} 尚未配置（v1 占位）`)
  }
})

const webSearchTool = placeholder(
  'web.search',
  'web_search',
  '联网搜索。需要先在设置中配置搜索 API（SerpAPI / Bing / 自建）。参数：query (string)，count (number, 默认 5)。',
  {
    type: 'object',
    properties: {
      query: { type: 'string' },
      count: { type: 'number' }
    },
    required: ['query'],
    additionalProperties: false
  }
)

const fileReadTool = placeholder(
  'file.read',
  'file_read',
  '读取应用授权目录下的文件内容（v1：仅 data/ 目录下）。参数：path (string，相对 data 目录)。',
  {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false
  }
)

const fileWriteTool = placeholder(
  'file.write',
  'file_write',
  '写入文件到应用 data 目录。需用户确认。参数：path (string)，content (string)。',
  {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['path', 'content'],
    additionalProperties: false
  }
)

const calendarReadTool = placeholder(
  'calendar.read',
  'calendar_read',
  '读取本地日历（v1 占位，后续接入 .ics 解析）。参数：range (string，如 today/this-week)。',
  {
    type: 'object',
    properties: { range: { type: 'string' } },
    required: ['range'],
    additionalProperties: false
  }
)

export const BUILTIN_TOOLS: BuiltinTool[] = [
  timeNowTool,
  calculatorTool,
  webFetchTool,
  webSearchTool,
  fileReadTool,
  fileWriteTool,
  calendarReadTool
]

// ---- 辅助：安全的数学表达式求值 ----
/**
 * 把数学表达式转成一个受限求值环境：仅允许数字、()、白名单运算符与函数。
 * 用 Function 构造器在沙箱对象作用域内求值。出于安全考虑，禁止访问全局对象。
 */
function safeMathEval(expr: string): number {
  // 仅允许：数字、空格、运算符、()、函数名、点
  if (!/^[\d\s+\-*/%().,a-z_]+$/i.test(expr)) {
    throw new Error('表达式包含非法字符')
  }
  const allowed = {
    abs: Math.abs,
    sqrt: Math.sqrt,
    min: Math.min,
    max: Math.max,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    ln: Math.log,
    log: Math.log10,
    log10: Math.log10,
    exp: Math.exp,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    PI: Math.PI,
    E: Math.E
  }
  // 用 new Function 在严格模式下求值，禁用 this 与 global
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'ctx',
    '"use strict"; const { abs, sqrt, min, max, sin, cos, tan, ln, log, log10, exp, round, floor, ceil, PI, E } = ctx; return (' + expr + ');'
  )
  try {
    const result = fn(allowed)
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('结果不是有限数字')
    }
    return result
  } catch (e) {
    throw new Error(`表达式求值失败: ${(e as Error).message}`)
  }
}

// ---- 辅助：从 HTML 抽取正文 ----
function extractReadableText(html: string, maxChars: number): string {
  // 延迟加载 cheerio，避免影响启动
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cheerio = require('cheerio') as typeof import('cheerio')
  const $ = cheerio.load(html)
  // 移除明显非正文元素
  $('script,style,noscript,iframe,nav,footer,header,aside,form,button').remove()
  $('[role=banner],[role=navigation],[role=search]').remove()
  // 优先 main / article
  const main = $('main, article, .post, .content, #content').first()
  const root = main.length ? main : $('body')
  const text = root.text().replace(/\s+/g, ' ').trim()
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m ? m[1].trim() : ''
}
