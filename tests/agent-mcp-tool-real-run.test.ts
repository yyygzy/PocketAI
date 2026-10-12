// B58① / B54 的真机替代验证：真 MCP 子进程 + 真引擎循环 + 真 HTTP 端点，串成一条链
//
// 为什么要这条：Iter-110 收紧成「'*' 只给内置、MCP 逐条授权」之后，"勾了一条就能用"
// 这句话从来没有被执行层证据——`filterByPermissions` 里那条为 `'*'` 单开的分支
// （`return builtin`）把逐条点名的 MCP 工具也一起丢掉了，而提示语（Iter-113）正叫用户去勾。
// 单测没抓到是因为它只喂了 `['*']` 与 `['mcp:…']` 两种各一半的权限，没测两者合起来那种。
// 这里把三样真的东西接起来：真 stdio MCP server（fixture，3 个工具）+ 真 agentEngine.run
// + 真本地端点；端点按清单里的函数名回一段原生 tool_calls，然后要求**暗号真的从子进程取回来了**。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-real-run'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'
import { mcpCallLogRepo } from '../src/main/db/repositories/mcp-call-log.repo'
import { mcpManager } from '../src/main/mcp/manager'
import { toolRegistry } from '../src/main/tools/registry'
import { resolveApproval } from '../src/main/agent/tool-approval'
import { agentEngine } from '../src/main/agent/engine'
import { IPC, type AgentDoneEvent } from '../src/shared/types'

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-probe-server.cjs')
const MODEL = 'fake-native-toolcall'
/** fixture 自报的工具名（改 fixture 要同步改这里） */
const PROBE_TOOL = 'probe_alpha'
const SECRET = '紫岚-7731'

let server: http.Server
let baseUrl = ''
let bodies: Record<string, unknown>[] = []
/** 置 true 时端点会回一段原生 tool_calls（函数名取请求清单里第一条 mcp_* 工具） */
let callMcpTool = false
let providerId = ''
let mcpServerId = ''

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

function sseToolCall(res: http.ServerResponse, name: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(part({ tool_calls: [{ index: 0, id: 'call_mcp_1', type: 'function', function: { name, arguments: '' } }] }))
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

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
        // 把子进程真的返回了什么照抄进回答：断言"暗号来自子进程"靠的就是这一句
        sse(res, `工具说：${lastText.slice(0, 200)}`)
        return
      }
      const target = fnNames(body).find((n) => n.startsWith('probe_'))
      if (callMcpTool && target) {
        sseToolCall(res, target)
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
    name: '端点探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id

  // 生产里这条接线在 registerMcpHandlers 里（`mcpManager.onCall → mcpCallLogRepo.append`），
  // 本文件不注册 IPC，所以按同一形状接一次，好让「调用记录」成为可断言的证据
  mcpManager.onCall((evt) => {
    try {
      mcpCallLogRepo.append(evt)
    } catch {
      /* 与生产一致：记录写失败不影响调用 */
    }
  })

  mcpServerId = mcpServerRepo.save({
    name: 'probe-server',
    transport: 'stdio',
    runtime: 'node',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true
  }).id
  await mcpManager.start(mcpServerId)
})

afterAll(async () => {
  await mcpManager.stopAll().catch(() => {})
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

async function run(
  toolPermissions: string[],
  content: string
): Promise<{ done: AgentDoneEvent | null; approvals: string[] }> {
  bodies = []
  const asst = assistantRepo.save({ name: `助手-${toolPermissions.join('-')}`, toolPermissions })
  const conv = conversationRepo.create({ assistantId: asst.id, title: 'e2e', titleDefault: false })
  let done: AgentDoneEvent | null = null
  const approvals: string[] = []
  const emit = (channel: string, data: unknown) => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    if (channel === IPC.AGENT_TOOL_APPROVAL_EVENT) {
      const id = (data as { approvalId?: string }).approvalId
      if (id) {
        approvals.push(id)
        // 等价于用户在弹窗上点了「允许」：MCP 工具默认一律 confirm（SEC-5），
        // 不接这一步引擎会一直等到审批超时
        resolveApproval(id, true)
      }
    }
  }
  await agentEngine.run(
    {
      requestId: `req-${Date.now()}-${approvals.length}`,
      conversationId: conv.id,
      assistantId: asst.id,
      content,
      agentMode: true,
      targets: [{ providerId, model: MODEL }]
    },
    emit
  )
  return { done, approvals }
}

describe('B58①：`*` 助手逐条勾上的 MCP 工具真的进了可用清单、也真的跑得起来', () => {
  it('只用 `*`（不点名）：发给端点的清单里一个 MCP 工具都没有，且 done 事件报 3 个被挡', async () => {
    callMcpTool = false
    const { done } = await run(['*'], '随便聊两句')
    expect(done).not.toBeNull()
    expect(fnNames(bodies[0]!)).not.toContain(PROBE_TOOL)
    expect(done!.mcpHeldBack).toBe(3)
    expect(done!.usedTools).toBe(false)
  })

  it('反向对照：不用 `*`、只点名内置一条时，不该报"有 MCP 被挡"（那条提示是骗人的就不能出现）', async () => {
    callMcpTool = false
    const { done } = await run(['time.now'], '随便聊两句')
    expect(fnNames(bodies[0]!)).not.toContain(PROBE_TOOL)
    expect(done!.mcpHeldBack).toBeUndefined()
  })

  it('点名一条 MCP 工具：它出现在发给端点的清单里 ⇒ 端点回原生 tool_calls ⇒ 引擎真的调用子进程并把暗号带回回答', async () => {
    const granted = `mcp:${mcpServerId}:${PROBE_TOOL}`
    callMcpTool = true
    const { done, approvals } = await run(['*', granted], `用 ${PROBE_TOOL} 查暗号`)
    // ① 清单里真的有它（这就是修复前丢掉的那一步）
    expect(fnNames(bodies[0]!)).toContain(PROBE_TOOL)
    // ② 引擎为这条 MCP 工具弹了确认（SEC-5：server 自报名字，默认一律人工确认）
    expect(approvals.length).toBeGreaterThan(0)
    // ③ 真的跑过子进程：调用记录落库，且带着 server 返回的暗号
    const logs = mcpCallLogRepo.list(mcpServerId, 20)
    expect(logs.some((l) => l.tool === PROBE_TOOL && l.ok)).toBe(true)
    // ④ 暗号是从子进程回来的，不是模型编的
    expect(done!.usedTools).toBe(true)
    expect(done!.fullContent).toContain(SECRET)
    callMcpTool = false
  })

  it('没点名那条就仍然调不到（点名是"逐条"的，不是一条带来一批）', async () => {
    const granted = `mcp:${mcpServerId}:${PROBE_TOOL}`
    callMcpTool = true
    const { done } = await run([granted], `用 probe_gamma 查数字`)
    const names = fnNames(bodies[0]!)
    expect(names).toContain(PROBE_TOOL)
    expect(names).not.toContain('probe_gamma')
    expect(done!.fullContent).not.toContain('4217')
    callMcpTool = false
  })

  it('注册表口径：`*` + 点名那条 = 内置全给 + 只多那一条 MCP', () => {
    const granted = `mcp:${mcpServerId}:${PROBE_TOOL}`
    const both = toolRegistry.filterByPermissions(['*', granted]).map((t) => t.id)
    const builtinOnly = toolRegistry.filterByPermissions(['*']).map((t) => t.id)
    expect(both.filter((id) => id.startsWith('mcp:'))).toEqual([granted])
    expect(both.length).toBe(builtinOnly.length + 1)
  })
})
