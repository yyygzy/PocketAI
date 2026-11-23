// MCP 符号导航桥：把外部 MCP Server 提供的 LSP / 语义查询工具收成统一入口。
//
// 为什么需要：内建 code.symbol 只覆盖 TypeScript Language Service（TS/JS/TSX/JSX）。
// Python/Go/Rust 的语义导航通常由外部 LSP bridge（作为 MCP Server 运行）提供，
// 这里按工具名识别 definition/references/implementation/workspaceSymbol/hover，
// 把统一参数翻成 MCP 调用；不猜 schema、不绕过 MCP 自己的权限链。
//
// 安全口径：
//  - 权限 confirm，不能因为名字像"查询"就静默调用外部 server；
//  - 跳过 deny / 自述 destructive 的工具；注解只作过滤，不作授权依据；
//  - file 参数必须落在 Agent 工作目录内（复用 resolveWorkspacePath）；
//  - 结果截断到 250KB，避免把上下文撑爆。
import type { BuiltinTool } from './builtin'
import type { ToolSchema } from '../../shared/types'
import { mcpManager } from '../mcp/manager'
import { resolveWorkspacePath } from './fs-tools'
import { errMsg } from '../error'
import path from 'node:path'

type Operation = 'definition' | 'references' | 'implementation' | 'workspaceSymbol' | 'hover'

const OPERATIONS: ReadonlySet<string> = new Set<Operation>([
  'definition', 'references', 'implementation', 'workspaceSymbol', 'hover'
])
const MAX_RESULT_CHARS = 250_000
const MAX_EXTRA_KEYS = 16
const TIMEOUT_MS = 60_000

interface MatchRule {
  operation: Operation
  pattern: RegExp
}

// 同时兼容常见 LSP 命名（textDocument/definition 会被 normalizeMcpTool 改成 textDocument_definition）
// 与 MCP 生态常见的 lsp_definition / find_references 风格。
const MATCH_RULES: MatchRule[] = [
  { operation: 'definition', pattern: /(^|[/_.-])(goto_?definition|find_?definition|definition)([/_.-]|$)/i },
  { operation: 'references', pattern: /(^|[/_.-])(find_?references|references)([/_.-]|$)/i },
  { operation: 'implementation', pattern: /(^|[/_.-])(find_?implementations?|implementations?)([/_.-]|$)/i },
  { operation: 'workspaceSymbol', pattern: /(^|[/_.-])(workspace_?symbols?|search_?symbols?)([/_.-]|$)/i },
  { operation: 'hover', pattern: /(^|[/_.-])(hover)([/_.-]|$)/i }
]

interface SymbolArgs {
  operation?: unknown
  query?: unknown
  file?: unknown
  line?: unknown
  character?: unknown
  language?: unknown
  serverId?: unknown
  toolName?: unknown
  maxResults?: unknown
  extra?: unknown
}

interface Candidate {
  schema: ToolSchema
  operation: Operation
}

function parseOperation(raw: unknown): Operation {
  const op = String(raw ?? '').trim()
  if (!OPERATIONS.has(op)) {
    throw new Error(`operation 必须是 ${[...OPERATIONS].join(' / ')} 之一`)
  }
  return op as Operation
}

function isUsable(schema: ToolSchema): boolean {
  if (schema.permission === 'deny') return false
  if (schema.mcpAnnotations?.destructiveHint === true) return false
  if (schema.mcpAnnotations?.readOnlyHint === false) return false
  return true
}

function operationOf(name: string): Operation | null {
  for (const rule of MATCH_RULES) {
    if (rule.pattern.test(name)) return rule.operation
  }
  return null
}

function listCandidates(serverId?: string): Candidate[] {
  const out: Candidate[] = []
  for (const runtime of mcpManager.listRuntimes()) {
    if (runtime.status !== 'running') continue
    if (serverId && runtime.id !== serverId) continue
    for (const schema of runtime.tools) {
      if (!isUsable(schema)) continue
      const operation = operationOf(schema.name)
      if (operation) out.push({ schema, operation })
    }
  }
  return out
}

function sanitizeExtra(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const reserved = new Set([
    'operation', 'query', 'file', 'line', 'character', 'language',
    'path', 'uri', 'position', 'maxResults'
  ])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_EXTRA_KEYS) break
    if (reserved.has(k)) continue
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) continue
    out[k] = v
  }
  return out
}

function stringifyResult(raw: unknown): string {
  let text: string
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  } catch {
    text = String(raw)
  }
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n...[已截断，原始结果超过 250KB]`
    : text
}

const mcpSymbolTool: BuiltinTool = {
  schema: {
    id: 'mcp.symbol',
    name: 'mcp_symbol',
    description:
      '通过已启动的 MCP Server 做语义符号导航，适合 Python/Go/Rust 等非 TS 语言。operation 取 definition / references / implementation / workspaceSymbol / hover。优先传 query；需要精确位置时传 file + line + character（均从 1 开始）与可选 language。可用 serverId 或 toolName 指定目标工具；extra 可传 server 特有参数（会被过滤保留字段）。',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: [...OPERATIONS] },
        query: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        language: { type: 'string' },
        serverId: { type: 'string' },
        toolName: { type: 'string' },
        maxResults: { type: 'number' },
        extra: { type: 'object' }
      },
      required: ['operation'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'confirm',
    timeoutMs: TIMEOUT_MS
  },
  async execute(args) {
    const a = args as SymbolArgs
    const operation = parseOperation(a.operation)
    const serverId = a.serverId === undefined || a.serverId === null ? '' : String(a.serverId).trim()
    const toolName = a.toolName === undefined || a.toolName === null ? '' : String(a.toolName).trim()

    let candidates = listCandidates(serverId || undefined)
    if (toolName) {
      candidates = candidates.filter((c) =>
        c.schema.name === toolName || (c.schema.remoteName ?? c.schema.name) === toolName
      )
      if (candidates.length === 0) throw new Error(`MCP Server 上没有可用工具：${toolName}`)
    } else {
      candidates = candidates.filter((c) => c.operation === operation)
      if (candidates.length === 0) {
        throw new Error(
          '没有已启动的 MCP Server 提供该类符号导航工具；请启动 LSP bridge，或用 toolName 指定工具'
        )
      }
    }
    const chosen = candidates[0]!
    const schema = chosen.schema

    const payload: Record<string, unknown> = {
      operation,
      ...sanitizeExtra(a.extra)
    }
    const query = a.query === undefined || a.query === null ? '' : String(a.query).trim()
    const language = a.language === undefined || a.language === null ? '' : String(a.language).trim()
    if (query) payload.query = query
    if (language) payload.language = language

    const fileRaw = a.file === undefined || a.file === null ? '' : String(a.file).trim()
    if (fileRaw) {
      const root = resolveWorkspacePath('.')
      const abs = resolveWorkspacePath(fileRaw)
      const relative = path.relative(root, abs).replace(/\\/g, '/')
      payload.file = relative || fileRaw
      payload.path = payload.file
      payload.uri = `file:///${abs.replace(/\\/g, '/').replace(/^\/+/, '')}`
      const line = a.line === undefined || a.line === null ? undefined : Number(a.line)
      const character = a.character === undefined || a.character === null ? undefined : Number(a.character)
      if (line === undefined !== (character === undefined)) {
        throw new Error('line 与 character 必须同时提供')
      }
      if (line !== undefined && character !== undefined) {
        if (!Number.isInteger(line) || line < 1 || !Number.isInteger(character) || character < 1) {
          throw new Error('line 与 character 必须是 >= 1 的整数')
        }
        payload.line = line
        payload.character = character
        payload.position = { line, character }
      }
    } else if (operation !== 'workspaceSymbol' && !query) {
      throw new Error('非 workspaceSymbol 操作必须提供 query 或 file')
    }

    const maxResults = a.maxResults === undefined || a.maxResults === null ? undefined : Number(a.maxResults)
    if (maxResults !== undefined) {
      if (!Number.isFinite(maxResults) || maxResults < 1) throw new Error('maxResults 必须是正数')
      payload.maxResults = Math.min(100, Math.floor(maxResults))
    }

    try {
      const raw = await mcpManager.callTool(
        schema.mcpServerId ?? serverId,
        schema.remoteName ?? schema.name,
        payload,
        'agent'
      )
      return JSON.stringify({
        ok: true,
        operation,
        serverId: schema.mcpServerId ?? serverId,
        tool: schema.remoteName ?? schema.name,
        result: stringifyResult(raw)
      })
    } catch (e) {
      return JSON.stringify({
        ok: false,
        operation,
        serverId: schema.mcpServerId ?? serverId,
        tool: schema.remoteName ?? schema.name,
        error: errMsg(e)
      })
    }
  }
}

/**
 * 恒定注册一张统一入口：MCP Server 启停频繁，若在注册期探测可用工具，
 * 每次 buildIndex 都会多打一次 listRuntimes（registry 自己还要打一次），
 * 且 server 刚起来时工具面会闪烁。调用期发现不到工具时给出明确报错即可。
 */
export function getMcpSymbolTools(): BuiltinTool[] {
  return [mcpSymbolTool]
}
