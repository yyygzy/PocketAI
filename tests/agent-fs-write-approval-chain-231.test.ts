// @vitest-environment node
// V4-Iter-231 的真链证据：fs_write 升成 confirm 之后，**审批弹窗真的带得出 diff、批准前真的没写盘、拒绝真的没写**。
//
// 为什么还要这一条（`fs-write-restore-231.test.ts` 已经测过工具本身）：那批测的是 fs-tools 的函数，
// 而"引擎在落盘前把 diff 交出来"这句话落在 `engine.ts` 的 `buildApprovalDisplay` 那一支上——
// 那一支坏了，用户看到的就还是裸 JSON，而函数级用例全绿。与 §139/§218/§220 同一理由：**接线要真链跑**。
//
// 形状复用 `agent-mcp-tool-real-run.test.ts`：真 SQLite + 真引擎循环 + 真本地 HTTP 端点（端点按请求里的
// 函数名回一段原生 tool_calls）。桩掉的只有 `portable`（把数据目录挪进临时目录）与 logger。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-231-chain'
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
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { agentEngine } from '../src/main/agent/engine'
import { resolveApproval } from '../src/main/agent/tool-approval'
import { IPC, type ToolApprovalRequestEvent } from '../src/shared/types'

const MODEL = 'fake-toolcall'
const WS = path.join(P.dir, 'workspace')
const SNAPS = path.join(P.data, 'agent-file-snapshots')

let server: http.Server
let baseUrl = ''
let providerId = ''
/** 端点下一次要回的工具调用（path/content 由用例设）；null 表示直接回文本 */
let pendingCall: { path: string; content: string } | null = null

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseWriteCall(res: http.ServerResponse, rel: string, content: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  const args = JSON.stringify({ path: rel, content })
  res.write(
    part({
      tool_calls: [{ index: 0, id: 'call_fs_1', type: 'function', function: { name: 'fs_write', arguments: '' } }]
    })
  )
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(WS, { recursive: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  // 工作目录一设，fs_list/fs_read/fs_write 才注册（引擎才会把 fs_write 发给端点）
  appConfigRepo.set('agent.workspace_dir', WS)

  server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
      const msgs = (body.messages ?? []) as { role: string; content: unknown }[]
      const last = msgs[msgs.length - 1]
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      // 工具结果回来后一律收尾（这一批只关心第一轮有没有把 diff 交出来）
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sse(res, `收尾：${lastText.slice(0, 120)}`)
        return
      }
      if (pendingCall) {
        const c = pendingCall
        sseWriteCall(res, c.path, c.content)
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

/**
 * 起一轮并**不等它结束**：审批是引擎在循环里 await 的，await 完整轮再点批准会直接互锁
 * （MCP 那条用例之所以能 await，是因为它在 emit 里同步就点了）。
 * `decide` 在审批事件到达的当下执行（可以顺手记下"此刻盘上有没有这份文件"）。
 */
function startRun(
  decide: (req: ToolApprovalRequestEvent) => void,
  opts: { unattended?: boolean } = {}
): { promise: Promise<void>; approvals: ToolApprovalRequestEvent[]; convId: string } {
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: ['*'] })
  const conv = conversationRepo.create({ assistantId: asst.id, title: 'e2e', titleDefault: false })
  const approvals: ToolApprovalRequestEvent[] = []
  const emit = (channel: string, data: unknown): void => {
    if (channel !== IPC.AGENT_TOOL_APPROVAL_EVENT) return
    const req = data as ToolApprovalRequestEvent
    approvals.push(req)
    decide(req)
  }
  const promise = agentEngine.run(
    {
      requestId: `req-${Date.now()}`,
      conversationId: conv.id,
      assistantId: asst.id,
      content: '把这段写进文件',
      agentMode: true,
      unattended: opts.unattended,
      targets: [{ providerId, model: MODEL }]
    },
    emit
  )
  return { promise, approvals, convId: conv.id }
}

/** 该轮的 fs_write 工具结果原文（引擎会把结果落成 role=tool 的消息） */
function toolRow(convId: string): string {
  return messageRepo
    .listByConversation(convId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content ?? '')
    .join('\n')
}

describe('① 批准前不写盘，弹窗载荷里真的有 diff', () => {
  it('审批到达时文件还不存在；点允许之后才落盘，且留下一份快照', async () => {
    const rel = 'notes/a.md'
    fs.rmSync(path.join(WS, 'notes'), { recursive: true, force: true })
    pendingCall = { path: rel, content: '新内容一\n新内容二\n' }
    let existedWhenAsked = true
    try {
      const { promise, approvals, convId } = startRun((req) => {
        // 就在审批事件到达的此刻取盘上状态：这一刻文件必须还不存在
        existedWhenAsked = fs.existsSync(path.join(WS, rel))
        resolveApproval(req.approvalId, true)
      })
      await promise

      expect(approvals, 'fs_write 是 confirm 档，必须弹审批').toHaveLength(1)
      const req = approvals[0]!
      expect(req.toolName).toBe('fs_write')
      expect(req.reason).toBe('FS_WRITE_NEW')
      expect(req.fields?.map((f) => f.key)).toEqual([
        'fs_write_path',
        'fs_write_abs',
        'fs_write_stats',
        'fs_write_diff'
      ])
      expect(req.fields?.[3]?.value).toContain('+ 新内容一')
      expect(existedWhenAsked, '审批还没点就写盘了').toBe(false)
      expect(fs.existsSync(path.join(WS, rel))).toBe(true)
      expect(fs.readFileSync(path.join(WS, rel), 'utf-8')).toBe('新内容一\n新内容二\n')

      const rows = messageRepo
        .listByConversation(convId)
        .filter((m) => m.role === 'tool' && (m.content ?? '').includes(rel))
      const last = rows[rows.length - 1]
      expect(last, '没找到这一次写的工具结果').toBeTruthy()
      const envelope = JSON.parse(String(last!.content)) as { name: string; content: string; isError: boolean }
      expect(envelope.name).toBe('fs_write')
      expect(envelope.isError).toBe(false)
      const res = JSON.parse(envelope.content) as { created: boolean; snapshotId: string }
      expect(res.created).toBe(true)
      expect(res.snapshotId).toMatch(/^[0-9a-f-]{36}$/)
      expect(fs.existsSync(path.join(SNAPS, `${res.snapshotId}.json`)), '没留快照，「还原」就是空话').toBe(true)
    } finally {
      pendingCall = null
    }
  })
})

describe('② 拒绝那一支：磁盘不许动', () => {
  it('点拒绝 ⇒ 引擎不执行，工具结果里是那句"用户拒绝"，文件仍然不存在', async () => {
    const rel = 'notes/denied.md'
    fs.rmSync(path.join(WS, 'notes'), { recursive: true, force: true })
    pendingCall = { path: rel, content: '不该落盘\n' }
    try {
      const { promise, approvals, convId } = startRun((req) => resolveApproval(req.approvalId, false))
      await promise

      expect(approvals).toHaveLength(1)
      expect(fs.existsSync(path.join(WS, rel))).toBe(false)
      expect(toolRow(convId)).toContain('用户拒绝')
      // 反向对照：被拒那一笔**不该留下快照**（快照是执行时才留的）
      const mine = (fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS) : [])
        .filter((f) => f.endsWith('.json'))
        .filter((f) => fs.readFileSync(path.join(SNAPS, f), 'utf-8').includes(rel))
      expect(mine, '拒掉了还在盘上留一份快照，等于偷偷写了').toHaveLength(0)
    } finally {
      pendingCall = null
    }
  })
})

describe('③ 无人值守（子 run）那一支的后果被钉住', () => {
  it('unattended ⇒ 不弹窗、直接回一句"需人工确认"，文件不写', async () => {
    const rel = 'notes/child.md'
    fs.rmSync(path.join(WS, 'notes'), { recursive: true, force: true })
    pendingCall = { path: rel, content: '子代理写的\n' }
    try {
      const { promise, approvals, convId } = startRun(() => {}, { unattended: true })
      await promise

      expect(approvals, '无人值守不该弹审批').toHaveLength(0)
      expect(toolRow(convId)).toContain('无人值守')
      expect(fs.existsSync(path.join(WS, rel))).toBe(false)
    } finally {
      pendingCall = null
    }
  })
})
