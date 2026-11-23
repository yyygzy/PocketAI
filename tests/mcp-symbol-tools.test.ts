// @vitest-environment node
// MCP 符号桥：真跑发现/参数构造，只桩 mcpManager 的进程调用。
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ToolSchema } from '../src/shared/types'

const state = vi.hoisted(() => ({
  ws: '',
  runtimes: [] as Array<{ id: string; status: string; tools: ToolSchema[] }>,
  calls: [] as Array<{ serverId: string; name: string; args: Record<string, unknown>; source: string }>,
  failNext: false
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => (k === 'agent.workspace_dir' ? state.ws : null),
    set: () => {},
    delete: () => {}
  }
}))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    listRuntimes: () => state.runtimes,
    callTool: async (serverId: string, name: string, args: Record<string, unknown>, source: string) => {
      state.calls.push({ serverId, name, args, source })
      if (state.failNext) {
        state.failNext = false
        throw new Error('mcp down')
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  }
}))

import { getMcpSymbolTools } from '../src/main/tools/mcp-symbol-tools'

function schema(name: string, extra: Partial<ToolSchema> = {}): ToolSchema {
  return {
    id: `mcp:lsp:${name}`,
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    source: 'mcp',
    mcpServerId: 'lsp',
    permission: 'auto',
    ...extra
  }
}

beforeAll(() => {
  state.ws = mkdtempSync(path.join(tmpdir(), 'pocketai-mcp-symbol-'))
  writeFileSync(path.join(state.ws, 'main.py'), 'def hello():\n    pass\n', 'utf8')
})

beforeEach(() => {
  state.runtimes = []
  state.calls = []
  state.failNext = false
})

describe('mcp.symbol 注册与安全筛选', () => {
  it('恒定注册统一入口，不在注册期探测 MCP 运行时', () => {
    state.runtimes = [{ id: 'lsp', status: 'running', tools: [schema('files_read')] }]
    expect(getMcpSymbolTools()).toHaveLength(1)
  })

  it('发现 lsp_definition 后注册 confirm 工具', () => {
    state.runtimes = [{ id: 'lsp', status: 'running', tools: [schema('lsp_definition')] }]
    const tools = getMcpSymbolTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]!.schema).toMatchObject({
      id: 'mcp.symbol',
      name: 'mcp_symbol',
      source: 'builtin',
      permission: 'confirm',
      timeoutMs: 60_000
    })
  })

  it('跳过 deny 与自述破坏性的工具', async () => {
    state.runtimes = [{
      id: 'lsp',
      status: 'running',
      tools: [
        schema('lsp_references', { permission: 'deny' }),
        schema('lsp_hover', { mcpAnnotations: { destructiveHint: true } })
      ]
    }]
    const tool = getMcpSymbolTools()[0]!
    await expect(tool.execute({ operation: 'references', query: 'hello' }))
      .rejects.toThrow('没有已启动的 MCP Server')
    expect(state.calls).toHaveLength(0)
  })
})

describe('mcp.symbol 调用', () => {
  it('按 operation 选中工具并传统一 payload', async () => {
    state.runtimes = [{
      id: 'lsp',
      status: 'running',
      tools: [schema('lsp_definition'), schema('lsp_references')]
    }]
    const tool = getMcpSymbolTools()[0]!
    const raw = await tool.execute({
      operation: 'definition',
      query: 'hello',
      language: 'python',
      maxResults: 200,
      extra: { depth: 3, operation: 'hacked' }
    })
    const out = JSON.parse(raw) as { ok: boolean; tool: string; result: string }
    expect(out.ok).toBe(true)
    expect(out.tool).toBe('lsp_definition')
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]).toMatchObject({
      serverId: 'lsp',
      name: 'lsp_definition',
      source: 'agent',
      args: {
        operation: 'definition',
        query: 'hello',
        language: 'python',
        maxResults: 100,
        depth: 3
      }
    })
    expect(state.calls[0]!.args.operation).toBe('definition')
  })

  it('file 参数转相对路径与 file:// URI，并做工作目录守卫', async () => {
    state.runtimes = [{ id: 'lsp', status: 'running', tools: [schema('lsp_references')] }]
    const tool = getMcpSymbolTools()[0]!
    const raw = await tool.execute({
      operation: 'references',
      file: 'main.py',
      line: 1,
      character: 5
    })
    const out = JSON.parse(raw) as { ok: boolean }
    expect(out.ok).toBe(true)
    const args = state.calls[0]!.args
    expect(args.file).toBe('main.py')
    expect(args.path).toBe('main.py')
    expect(String(args.uri)).toContain('main.py')
    expect(args.position).toEqual({ line: 1, character: 5 })

    await expect(tool.execute({
      operation: 'references',
      file: '../secret.py',
      line: 1,
      character: 1
    })).rejects.toThrow()
  })

  it('MCP 失败返回结构化 ok=false，不抛给引擎', async () => {
    state.runtimes = [{ id: 'lsp', status: 'running', tools: [schema('lsp_workspace_symbols')] }]
    state.failNext = true
    const tool = getMcpSymbolTools()[0]!
    const out = JSON.parse(await tool.execute({ operation: 'workspaceSymbol', query: 'hello' })) as {
      ok: boolean
      error: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('mcp down')
  })
})
