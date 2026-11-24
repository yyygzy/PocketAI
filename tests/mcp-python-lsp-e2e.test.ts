// @vitest-environment node
// 真实端到端：McpManager -> stdio -> mcp_python_lsp_bridge.py -> pylsp。
// 本机没装 venv 时跳过，不把环境依赖变成 CI 失败。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { McpServerRecord } from '../src/shared/types'

const ROOT = process.cwd()
const WS = path.join(ROOT, 'tests', 'fixtures', 'python-lsp-workspace')
const PYTHON = path.join(ROOT, 'artifacts', 'runtime', 'lsp-bridge-venv', 'Scripts', 'python.exe')
const SCRIPT = path.join(ROOT, 'scripts', 'mcp_python_lsp_bridge.py')
const HAS_ENV = existsSync(PYTHON) && existsSync(SCRIPT)

const record: McpServerRecord = {
  id: 'python-lsp-e2e',
  name: 'Python LSP E2E',
  transport: 'stdio',
  runtime: 'binary',
  command: PYTHON,
  args: [SCRIPT],
  env: { MOXIA_WORKSPACE: WS },
  url: null,
  headers: {},
  authMode: 'none',
  createdAt: Date.now(),
  trustReadOnly: true,
  pythonPackages: []
}

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: {
    list: () => [record],
    get: (id: string) => (id === record.id ? record : null)
  }
}))
vi.mock('../src/main/portable', () => ({
  MCP_EXTENSIONS_DIR: path.join(process.cwd(), 'tests', 'fixtures', 'python-lsp-workspace', '.mcp-ext')
}))
vi.mock('../src/main/mcp/outbound-policy', () => ({
  assertMcpConnectAllowed: () => {},
  getMcpSitePolicy: () => ({ allowedHosts: [], allowOtherHosts: true }),
  isMcpHostAllowed: () => true,
  mcpAllowedPrivateOrigin: () => undefined,
  sanitizeHost: () => ''
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { McpManager } from '../src/main/mcp/manager'

const manager = new McpManager()

function textOf(raw: unknown): string {
  const obj = raw as { content?: Array<{ text?: string }> }
  return obj?.content?.[0]?.text ?? ''
}

describe.skipIf(!HAS_ENV)('MCP Python LSP 真实链路', () => {
  beforeAll(async () => {
    await manager.start(record.id)
  }, 60_000)

  afterAll(async () => {
    await manager.stop(record.id).catch(() => {})
  })

  it('McpManager 握手后拿到 4 个 lsp_* 工具', () => {
    const runtime = manager.listRuntimes().find((r) => r.id === record.id)
    expect(runtime?.status).toBe('running')
    expect(runtime?.tools.map((t) => t.name).sort()).toEqual([
      'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_workspace_symbols'
    ])
  })

  it('mcp.symbol 对应的底层工具真能跳定义', async () => {
    const raw = await manager.callTool(record.id, 'lsp_definition', {
      operation: 'definition',
      query: 'add'
    }, 'agent')
    const out = JSON.parse(textOf(raw)) as {
      operation: string
      symbols: Array<{ file: string; line: number; preview: string }>
    }
    expect(out.operation).toBe('definition')
    expect(out.symbols.some((s) => s.file === 'pkg/calc.py' && s.preview.includes('def add'))).toBe(true)
  }, 30_000)

  it('底层工具真能查引用与工作区符号', async () => {
    const refsRaw = await manager.callTool(record.id, 'lsp_references', {
      operation: 'references',
      query: 'add'
    }, 'agent')
    const refs = JSON.parse(textOf(refsRaw)) as { symbols: Array<{ file: string }> }
    expect(refs.symbols.some((s) => s.file === 'pkg/use.py')).toBe(true)

    const symsRaw = await manager.callTool(record.id, 'lsp_workspace_symbols', {
      operation: 'workspaceSymbol',
      query: 'multiply',
      maxResults: 20
    }, 'agent')
    const syms = JSON.parse(textOf(symsRaw)) as { symbols: Array<{ file: string; preview: string }> }
    expect(syms.symbols.some((s) => s.file === 'pkg/calc.py' && s.preview.includes('multiply'))).toBe(true)
  }, 30_000)
})
