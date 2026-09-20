// 内置工具（M3.3 / M4.3）
// v1 实现：time.now / calculator / web.fetch
// v2 批次六：web.search 联网搜索真实现（websearch.ts + websearch-config.ts，默认关闭）
// v2 批次九：weather.query 免费天气（weather.ts，无需 Key）；calendar.read 本地 .ics 日历
// （calendar-ics.ts，默认关闭，Agent 页配置）。文件读写（fs.list / fs.read / fs.write）在
// fs-tools.ts，按工作目录配置动态注册。

import vm from 'node:vm'
import type { ToolSchema } from '../../shared/types'
import { runWebSearch } from './websearch'
import { runJsEval } from '../sandbox/js-eval-runner'
import { safeFetch } from '../net/safe-fetch'
import { weatherTool } from './weather'
import { calendarReadTool } from './calendar-ics'

/** 工具安全判定结果（与 ToolSchema.permission 基线取更严） */
export type ToolDecision = 'allow' | 'confirm' | 'deny'

export interface ToolClassification {
  decision: ToolDecision
  /** 稳定 reason code（如 DANGEROUS_DELETE / SHELL_DISABLED），供渲染端 i18n */
  reason?: string
}

export interface BuiltinTool {
  schema: ToolSchema
  /** ctx.signal 在 Agent 被中止时触发，长时运行工具（如 shell_exec）应据此立即终止 */
  execute(args: Record<string, unknown>, ctx?: ToolExecuteContext): Promise<string>
  /** 工具级动态判定（如 shell_exec 按策略/命令内容判定）；缺省时只看 schema.permission */
  classify?(args: Record<string, unknown>): ToolClassification
}

/** 工具执行上下文（目前只透传中止信号） */
export interface ToolExecuteContext {
  signal?: AbortSignal
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
  async execute(args, ctx) {
    const url = String(args?.url ?? '').trim()
    const maxChars = Number(args?.maxChars) > 0 ? Number(args.maxChars) : 8000
    if (!url) throw new Error('url 不能为空')
    if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')

    // safeFetch：逐跳 SSRF 校验（重定向不绕过）、响应体 5MB 上限、总超时、响应中止信号
    const res = await safeFetch(url, {
      signal: ctx?.signal,
      timeoutMs: 15_000,
      maxBytes: 5 * 1024 * 1024,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    })
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    const html = res.body.toString('utf8')
    const text = extractReadableText(html, maxChars)
    const title = extractTitle(html)
    return JSON.stringify({ url, title, content: text })
  }
}

// ---- 联网搜索（v2 批次六真实现）：默认关闭，Agent 页配置服务商与 Key 后启用 ----
const webSearchTool: BuiltinTool = {
  schema: {
    id: 'web.search',
    name: 'web_search',
    description:
      '联网搜索实时信息（新闻/资料/价格等），返回「标题+链接+摘要」列表。需用户在 Agent 页启用并配置搜索服务商；未启用时调用会报错。参数：query (string)，count (number, 可选, 默认 5, 最多 8)。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果条数，默认 5，最多 8' }
      },
      required: ['query'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args, ctx) {
    const query = String(args?.query ?? '').trim()
    if (!query) throw new Error('query 不能为空')
    const hits = await runWebSearch(query, Number(args?.count), ctx?.signal)
    if (hits.length === 0) return JSON.stringify({ query, results: [], note: '无搜索结果' })
    return JSON.stringify({ query, results: hits })
  }
}

// ---- 沙箱 JS 执行（v2 批次八）：隐藏 sandbox 窗口，无 Node/网络/DOM，5s 超时 ----
const jsEvalTool: BuiltinTool = {
  schema: {
    id: 'js.eval',
    name: 'js_eval',
    description:
      '在隔离沙箱中执行 JavaScript 进行计算或数据处理（无受信网络与文件访问、无 DOM、无 Node API；5 秒超时；结果序列化后截断 2000 字符）。代码是异步函数体，用 return 返回结果，例如 return [1,2,3].reduce((a,b)=>a+b,0)。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript 代码（异步 IIFE 函数体，可用 return 返回结果）' }
      },
      required: ['code'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args, ctx) {
    const code = String(args?.code ?? '')
    if (!code.trim()) throw new Error('code 不能为空')
    return runJsEval(code, ctx?.signal)
  }
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  timeNowTool,
  calculatorTool,
  webFetchTool,
  webSearchTool,
  jsEvalTool,
  weatherTool,
  calendarReadTool
]

// ---- 辅助：安全的数学表达式求值 ----
// 安全设计（修复原 new Function 沙箱逃逸 RCE）：
//  1. 字符白名单：仅数字/运算符/括号/逗号/点/字母/下划线，无引号、反引号、方括号、
//     分号、等号、反斜杠——无法构造字符串、属性下标或语句；
//  2. 标识符白名单：剥掉数字字面量（含科学计数法）后，剩余标识符必须全部在函数
//     白名单内。原实现仅解构白名单函数，process/globalThis 等自由标识符仍沿作用域
//     链可达全局，可经 process.mainModule.require(...) 任意执行命令；
//  3. vm 纵深防御：在无原型空沙箱对象 + 独立 V8 realm 中求值（100ms 超时），
//     白名单之外的内置对象（Function/Object 等）在 realm 内也无名字可达。
const MATH_ALLOWED: Record<string, number | ((...args: number[]) => number)> = {
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
const MATH_ALLOWED_KEYS = new Set(Object.keys(MATH_ALLOWED))

function safeMathEval(expr: string): number {
  if (expr.length > 500) throw new Error('表达式过长（上限 500 字符）')
  // 仅允许：数字、空格、运算符、()、函数名、点
  if (!/^[\d\s+\-*/%().,a-z_]+$/i.test(expr)) {
    throw new Error('表达式包含非法字符')
  }
  // 标识符白名单：数字字面量（含 1.5e-3 科学计数法）剥掉后，逐个校验剩余标识符
  const withoutNumbers = expr.replace(/\d+\.?\d*(?:[eE][+-]?\d+)?/g, ' ')
  for (const ident of withoutNumbers.match(/[a-z_][a-z0-9_]*/gi) ?? []) {
    if (!MATH_ALLOWED_KEYS.has(ident)) throw new Error(`不允许的标识符: ${ident}`)
  }
  try {
    const sandbox = Object.create(null) as Record<string, unknown>
    Object.assign(sandbox, MATH_ALLOWED)
    const context = vm.createContext(sandbox)
    const result: unknown = vm.runInContext(`(${expr})`, context, { timeout: 100 })
    if (typeof result !== 'number' || !Number.isFinite(result)) {
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
