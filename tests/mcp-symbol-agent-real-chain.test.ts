// @vitest-environment node
// 真配置链路：真实 SQLite 里的 MCP Server 记录 → McpManager 拉起 Python LSP 桥
// → 内置 mcp.symbol（toolRegistry.execute）→ 真 Agent 引擎循环调 mcp_symbol。
//
// 与 tests/mcp-python-lsp-e2e.test.ts 的区别：那份用 vi.mock 直接喂记录、只测 manager；
// 这份不 mock repo/manager/registry，走 mcpServerRepo.save 的持久化路径，
// 并用假 HTTP 端点让模型真的发起一次 mcp_symbol 工具调用。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-symbol-real-chain'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => P.dir,
    getAppPath: () => process.cwd(),
    on: () => {},
    quit: () => {}
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'
import { mcpCallLogRepo } from '../src/main/db/repositories/mcp-call-log.repo'
import { mcpManager } from '../src/main/mcp/manager'
import { toolRegistry } from '../src/main/tools/registry'
import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import { resolveApproval } from '../src/main/agent/tool-approval'
import { agentEngine } from '../src/main/agent/engine'
import { IPC, type AgentDoneEvent } from '../src/shared/types'

const ROOT = process.cwd()
const WS = path.join(ROOT, 'tests', 'fixtures', 'python-lsp-workspace')
const PYTHON = path.join(ROOT, 'artifacts', 'runtime', 'lsp-bridge-venv', 'Scripts', 'python.exe')
const SCRIPT = path.join(ROOT, 'scripts', 'mcp_python_lsp_bridge.py')
const HAS_ENV = fs.existsSync(PYTHON) && fs.existsSync(SCRIPT) && fs.existsSync(WS)

const MODEL = 'fake-mcp-symbol-toolcall'
let server: http.Server
let baseUrl = ''
let bodies: Record<string, unknown>[] = []
/** 置 true 时假端点回一次 mcp_symbol 工具调用 */
let callMcpSymbol = false
let providerId = ''
let serverId = ''

function fnNames(body: Record<string, unknown>): string[] {
  const tools = (body.tools ?? []) as { function?: { name?: string }; name?: string }[]
  return tools.map((t) => t.function?.name ?? t.name ?? '').filter(Boolean)
}

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseMcpSymbolCall(res: http.ServerResponse, args: Record<string, unknown>): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(
    part({
      tool_calls: [
        {
          index: 0,
          id: 'call_mcp_symbol_1',
          type: 'function',
          function: { name: 'mcp_symbol', arguments: '' }
        }
      ]
    })
  )
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** mcp.symbol 的返回值是 JSON 字符串，里面 result 字段又是一段 JSON 文本 */
function unwrapSymbolResult(content: string): {
  ok: boolean
  operation: string
  serverId: string
  tool: string
  payload?: { symbols?: Array<{ file: string; line: number; preview: string }> }
  error?: string
} {
  const outer = JSON.parse(content) as {
    ok: boolean
    operation: string
    serverId: string
    tool: string
    result?: string
    error?: string
  }
  // mcp.symbol → result 是 MCP 调用结果的 JSON 文本；桥的正文在 content[0].text
  const mcpResult = outer.result
    ? (JSON.parse(outer.result) as { content?: Array<{ text?: string }> })
    : undefined
  const text = mcpResult?.content?.[0]?.text
  const payload = text
    ? (JSON.parse(text) as { symbols?: Array<{ file: string; line: number; preview: string }> })
    : undefined
  return {
    ok: outer.ok,
    operation: outer.operation,
    serverId: outer.serverId,
    tool: outer.tool,
    ...(payload ? { payload } : {}),
    ...(outer.error ? { error: outer.error } : {})
  }
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  setWorkspaceDir(WS)

  server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
      bodies.push(body)
      const msgs = (body.messages ?? []) as { role: string; content: unknown }[]
      const last = msgs[msgs.length - 1]
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sse(res, `工具返回：${lastText.slice(0, 4000)}`)
        return
      }
      if (callMcpSymbol && fnNames(body).includes('mcp_symbol')) {
        sseMcpSymbolCall(res, { operation: 'workspaceSymbol', query: 'multiply', serverId })
        return
      }
      sse(res, '没有调用任何工具')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: 'mcp.symbol 端点探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id

  // 生产里这条接线在 registerMcpHandlers 里，按同一形状接一次，便于断言落库调用记录
  mcpManager.onCall((evt) => {
    try {
      mcpCallLogRepo.append(evt)
    } catch {
      /* 与生产一致：记录失败不影响调用 */
    }
  })

  // 真实配置持久化：桥的工作目录走 args[1]（脚本支持 argv 回退），
  // 不写 env，因此明文模式下也不会被 none 模式新密钥闸门拦下。
  serverId = mcpServerRepo.save({
    name: 'python-lsp-bridge-real',
    transport: 'stdio',
    runtime: 'binary',
    command: PYTHON,
    args: [SCRIPT, WS],
    autoConnect: true
  }).id
  await mcpManager.start(serverId)
}, 120_000)

afterAll(async () => {
  callMcpSymbol = false
  await mcpManager.stopAll().catch(() => {})
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe.skipIf(!HAS_ENV)('真实配置 → MCP → mcp.symbol → Agent 全链路', () => {
  it('配置真的落了库：取出记录仍是同一条、自动连接标记保留', () => {
    const rec = mcpServerRepo.get(serverId)
    expect(rec).not.toBeNull()
    expect(rec!.name).toBe('python-lsp-bridge-real')
    expect(rec!.command).toBe(PYTHON)
    expect(rec!.args).toEqual([SCRIPT, WS])
    expect(rec!.autoConnect).toBe(true)
  })

  it('mcpManager 从库记录启动桥，拿到 4 个 lsp_* 工具', () => {
    const runtime = mcpManager.listRuntimes().find((r) => r.id === serverId)
    expect(runtime?.status).toBe('running')
    expect(runtime?.tools.map((t) => t.name).sort()).toEqual([
      'lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_workspace_symbols'
    ])
  })

  it('toolRegistry.execute 直接调 mcp_symbol：定义跳转真回到 Python 源码', async () => {
    const res = await toolRegistry.execute(
      'mcp_symbol',
      JSON.stringify({ operation: 'definition', query: 'add', serverId }),
      new Set(['*'])
    )
    expect(res.isError).toBeFalsy()
    const out = unwrapSymbolResult(res.content)
    expect(out.ok).toBe(true)
    expect(out.operation).toBe('definition')
    expect(out.serverId).toBe(serverId)
    expect(out.tool).toBe('lsp_definition')
    expect(out.payload?.symbols?.some((s) => s.file === 'pkg/calc.py' && s.preview.includes('def add'))).toBe(true)
  }, 60_000)

  it('带 file + 行列的 mcp_symbol 调用走工作目录边界并命中同一定义', async () => {
    const res = await toolRegistry.execute(
      'mcp_symbol',
      JSON.stringify({
        operation: 'definition',
        file: 'pkg/use.py',
        line: 1,
        character: 22,
        serverId
      }),
      new Set(['*'])
    )
    expect(res.isError).toBeFalsy()
    const out = unwrapSymbolResult(res.content)
    expect(out.ok).toBe(true)
    expect(out.payload?.symbols?.some((s) => s.file === 'pkg/calc.py')).toBe(true)
  }, 60_000)

  it('真 Agent 循环：模型发起 mcp_symbol → 审批放行 → 桥结果进入最终回答', async () => {
    bodies = []
    callMcpSymbol = true
    const asst = assistantRepo.save({
      name: 'mcp.symbol 真链路助手',
      toolPermissions: ['*']
    })
    const conv = conversationRepo.create({ assistantId: asst.id, title: 'e2e-mcp-symbol', titleDefault: false })
    let done: AgentDoneEvent | null = null
    let approvals = 0
    await agentEngine.run(
      {
        requestId: `req-mcp-symbol-${Date.now()}`,
        conversationId: conv.id,
        assistantId: asst.id,
        content: '用 mcp_symbol 查 multiply 的定义',
        agentMode: true,
        targets: [{ providerId, model: MODEL }]
      },
      (channel: string, data: unknown) => {
        if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
        if (channel === IPC.AGENT_TOOL_APPROVAL_EVENT) {
          const id = (data as { approvalId?: string }).approvalId
          if (id) {
            approvals++
            // 等价于用户在弹窗点了「允许」：mcp.symbol 基线权限是 confirm
            resolveApproval(id, true)
          }
        }
      }
    )
    callMcpSymbol = false

    expect(fnNames(bodies[0]!)).toContain('mcp_symbol')
    expect(approvals).toBeGreaterThan(0)
    expect(done).not.toBeNull()
    expect(done!.usedTools).toBe(true)
    expect(done!.fullContent).toContain('pkg/calc.py')
    expect(done!.fullContent).toContain('multiply')

    // 调用记录里的 tool 是底层 MCP 工具，source=agent，证明是 mcp.symbol 转发出去的
    const logs = mcpCallLogRepo.list(serverId, 20)
    expect(
      logs.some((l) => l.tool === 'lsp_workspace_symbols' && l.ok && l.source === 'agent')
    ).toBe(true)
  }, 120_000)
})
