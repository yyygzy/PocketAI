// @vitest-environment node
// V4-Iter-232 的接线证据：**引擎真的把过阈值的那一份换成"引用 + 预览"**，而不是只有
// `contextToolResult` 这个函数自己测过（函数测过 ≠ 接上过，§231 同一批的理由）。
//
// 形状复用 `agent-fs-write-approval-chain-231.test.ts`：真 SQLite + 真引擎循环 + 真本地 SSE 端点。
// 这一条只跑一次工具（`js_eval` 回一段 25k 字符的串），然后看**第二次发给端点的那份载荷**里
// 出现的是 `@outputs/…` 引用 + 短预览，而不是那 25k 字符本身。
// 反向对照也在同一文件里：短结果那一轮不许出现引用（否则预览逻辑就恒开，白白多一次 fs 往返）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-232-chain'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import { agentEngine } from '../src/main/agent/engine'
import { agentTraceRepo } from '../src/main/db/repositories/agent-trace.repo'
import { OFFLOAD_PREFIX, OFFLOAD_THRESHOLD_CHARS } from '../src/main/agent/tool-output-offload'
import { IPC, type AgentDoneEvent } from '../src/shared/types'

const MODEL = 'fake-toolcall'
const LONG_CHARS = OFFLOAD_THRESHOLD_CHARS + 5_000
// 工作目录里放两份文件：长的用来触发卸载，短的做反向对照
const WS = path.join(P.dir, 'workspace')

let server: http.Server
let providerId = ''
/** 端点下一次要回的工具代码（null=直接给最终回答） */
/** 端点下一次要让它去读的文件路径（null=不给工具调用） */
let pendingRead: string | null = null
/** 每一次发给端点的请求体（第二条才含工具结果，判据就在它身上） */
let bodies: Record<string, unknown>[] = []

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseJsCall(res: http.ServerResponse, readPath: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(
    part({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '' } }] })
  )
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: readPath }) } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  fs.mkdirSync(WS, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  // 顺序要紧：setWorkspaceDir 要写 app_config，库没开就先落盘再设目录
  fs.writeFileSync(path.join(WS, 'long.txt'), 'q'.repeat(LONG_CHARS), 'utf-8')
  fs.writeFileSync(path.join(WS, 'short.txt'), '短结果', 'utf-8')
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
        sse(res, '看到了')
        return
      }
      if (pendingRead) {
        sseJsCall(res, pendingRead)
        return
      }
      sse(res, '没有调用任何工具')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
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
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/** 让端点回一次 fs_read(readPath)，读回来的就是那份工具结果 */
async function runOnce(readPath: string): Promise<{ done: AgentDoneEvent | null; convId: string }> {
  bodies = []
  pendingRead = readPath
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: ['fs.read'] })
  let done: AgentDoneEvent | null = null
  const convId = conversationRepo.create({ assistantId: asst.id, title: 'e2e', titleDefault: false }).id
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
  }
  try {
    await agentEngine.run(
      {
        requestId: `req-${Date.now()}`,
        conversationId: convId,
        assistantId: asst.id,
        content: '跑一段脚本',
        agentMode: true,
        targets: [{ providerId, model: MODEL }]
      },
      emit
    )
  } finally {
    pendingRead = null
  }
  return { done, convId }
}

/** 第二次发给端点的载荷里，那条工具结果的原文 */
function toolMessageContent(): string {
  const body = bodies[1]
  expect(body, '端点没收到第二次请求（工具那一步没跑起来？）').toBeTruthy()
  const msgs = (body!.messages ?? []) as { role: string; content: unknown }[]
  const tool = msgs.find((m) => m.role === 'tool') ?? msgs.find((m) => String(m.content ?? '').includes('[工具结果]'))
  expect(tool, '第二次请求里没有工具结果那条消息').toBeTruthy()
  return typeof tool!.content === 'string' ? tool!.content : JSON.stringify(tool!.content)
}

describe('① 过阈值：上下文里换成了引用 + 预览，而不是那 25k 字符', () => {
  it('引擎真的接上了卸载这一层', async () => {
    const { done, convId } = await runOnce('long.txt')
    expect(done, '这一轮没跑完').not.toBeNull()
    const text = toolMessageContent()
    expect(text).toContain(OFFLOAD_PREFIX)
    expect(text.length).toBeLessThan(4000)
    // 全文真的在盘上（引用不是空头支票）
    const root = path.join(P.data, 'agent-tool-outputs')
    const files = fs.readdirSync(root).filter((f) => f.endsWith('.txt'))
    expect(files.length).toBeGreaterThan(0)
    const full = fs.readFileSync(path.join(root, files[0]!), 'utf-8')
    // 卸载的是**那一步工具结果的原文**（fs_read 的 JSON 信封），不是文件本身——
    // 断言按这个口径写：长串必须在里面，长度不能低于原文
    expect(full).toContain('q'.repeat(1000))
    expect(full.startsWith('{')) .toBe(true)
    expect(full.length).toBeGreaterThanOrEqual(LONG_CHARS)

    // v50 那三列必须由引擎真的写进去——"schema 加了列、repo 没人写"在桩里是看不出来的
    const traces = agentTraceRepo.latestTracesByConversation(convId)
    const toolsStep = traces.find((tr) => tr.stepType === 'tools')
    expect(toolsStep, '没有 tools 那一步的 trace').toBeTruthy()
    expect(toolsStep!.model, 'model 这一列没写').toBe(MODEL)
    expect(toolsStep!.toolArgs, 'tool_args 这一列没写').toContain('fs_read')
    expect(toolsStep!.toolResult, 'tool_result 这一列没写').toContain('q'.repeat(200))
    // 上限是真的：那一列被截过，并且如实报了原始长度
    expect(toolsStep!.toolResult!.length).toBeLessThan(6000)
    expect(toolsStep!.toolResult).toMatch(/完整 \d+ 字符/)
  })
})

describe('② 反向对照：短结果不走卸载', () => {
  it('没过阈值 ⇒ 上下文里没有引用，也没有多落一个文件', async () => {
    const before = fs.existsSync(path.join(P.data, 'agent-tool-outputs'))
      ? fs.readdirSync(path.join(P.data, 'agent-tool-outputs')).length
      : 0
    const { done } = await runOnce('short.txt')
    expect(done).not.toBeNull()
    const text = toolMessageContent()
    expect(text).not.toContain(OFFLOAD_PREFIX)
    expect(text).toContain('短结果')
    const after = fs.readdirSync(path.join(P.data, 'agent-tool-outputs')).length
    expect(after).toBe(before)
  })
})
