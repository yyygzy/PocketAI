// Claude Desktop 风格 mcpServers JSON → PocketAI MCP Server 草稿 的纯解析（无依赖，直接 vitest）。
// 支持形态：
//   stdio: { "command": "npx", "args": [...], "env": {...} }
//   http:  { "url": "https://..." }
//          { "type": "http"|"sse", "url": "...", "headers": {...} }（sse 按 http 处理并告警）
// 单条失败不阻断其他条目；落库仍由 IPC 层 mcpServerSaveSchema 兜底校验。
import type { McpRuntime } from './types'

export interface McpImportDraft {
  name: string
  transport: 'stdio' | 'http'
  runtime: McpRuntime
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  pythonPackages: string[]
}

export interface McpImportItem {
  /** 源 JSON mcpServers 对象中的 key */
  key: string
  draft?: McpImportDraft
  error?: string
  /** 非阻断告警（如 sse 按 http 处理、字段被忽略） */
  warning?: string
}

export interface McpImportResult {
  items: McpImportItem[]
  /** 顶层结构非法（非 JSON / 缺 mcpServers 对象）时的整体错误 */
  error?: string
}

/**
 * 按 command basename 推断运行时：
 * node/npx/bun/bunx → node；python/python3/uv/uvx → python；其余 → binary。
 * Windows 下常带 .cmd/.exe 扩展名，先剥掉再匹配。
 */
export function inferMcpRuntime(command: string): McpRuntime {
  const base = command.replace(/\\/g, '/').split('/').pop() ?? command
  const stem = base.replace(/\.(cmd|exe|bat)$/i, '').toLowerCase()
  if (stem === 'node' || stem === 'npx' || stem === 'bun' || stem === 'bunx') return 'node'
  if (stem === 'python' || stem === 'python3' || stem === 'uv' || stem === 'uvx') return 'python'
  return 'binary'
}

/** 任意 JSON 值 → Record<string,string>（值 String 化；非对象返回 null 由调用方报错） */
function coerceStringRecord(raw: unknown): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
}

function parseEntry(key: string, raw: unknown): McpImportItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { key, error: '条目必须是 JSON 对象' }
  }
  const obj = raw as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : ''
  const url = typeof obj.url === 'string' ? obj.url.trim() : ''
  const command = typeof obj.command === 'string' ? obj.command.trim() : ''

  // type 显式声明 http/sse 优先；否则有 command 走 stdio，仅有 url 走 http
  const isHttp = type === 'http' || type === 'sse' || (!command && !!url)

  if (isHttp) {
    if (!url) return { key, error: 'http 条目缺少 url' }
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return { key, error: `url 不合法: ${url}` }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { key, error: 'url 仅支持 http(s) 协议' }
    }
    let headers: Record<string, string> = {}
    if (obj.headers !== undefined) {
      const h = coerceStringRecord(obj.headers)
      if (!h) return { key, error: 'headers 必须是 JSON 对象' }
      headers = h
    }
    const warning =
      type === 'sse'
        ? 'sse 类型按 http（Streamable HTTP）处理'
        : type && type !== 'http'
          ? `未识别的 type "${obj.type as string}"，按 http 处理`
          : undefined
    return {
      key,
      warning,
      draft: {
        name: key,
        transport: 'http',
        runtime: 'binary',
        command: null,
        args: [],
        env: {},
        url,
        headers,
        enabled: true,
        pythonPackages: []
      }
    }
  }

  // stdio
  if (!command) return { key, error: '缺少 command 或 url' }
  let args: string[] = []
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) return { key, error: 'args 必须是 JSON 数组' }
    args = obj.args.map(String)
  }
  let env: Record<string, string> = {}
  if (obj.env !== undefined) {
    const e = coerceStringRecord(obj.env)
    if (!e) return { key, error: 'env 必须是 JSON 对象' }
    env = e
  }
  return {
    key,
    draft: {
      name: key,
      transport: 'stdio',
      runtime: inferMcpRuntime(command),
      command,
      args,
      env,
      url: null,
      headers: {},
      enabled: true,
      pythonPackages: []
    }
  }
}

export function parseMcpServersJson(text: string): McpImportResult {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (e) {
    return { items: [], error: `JSON 解析失败：${(e as Error).message}` }
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return { items: [], error: '顶层必须是 JSON 对象' }
  }
  // 兼容两种形态：{ "mcpServers": {...} }（Claude Desktop 标准）或直接 { "<name>": {...} }
  const container =
    'mcpServers' in root ? (root as Record<string, unknown>).mcpServers : root
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return { items: [], error: '缺少 mcpServers 对象' }
  }
  const items = Object.entries(container as Record<string, unknown>).map(([key, v]) =>
    parseEntry(key, v)
  )
  if (items.length === 0) return { items, error: 'mcpServers 为空' }
  return { items }
}
