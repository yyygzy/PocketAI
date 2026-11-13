// §B 真链：project_create 写工作目录时，审批前不落盘、拒绝/中止/无人值守都零残留。
//
// 形状复用 agent-fs-write-approval-chain-231：真 SQLite + 真引擎循环 + 本地 HTTP 端点
// （端点按请求里的函数名回一段原生 tool_calls）。桩掉的只有 portable 与 logger。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-482-chain'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data', ws: dir + sep + 'workspace' }
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
const WS = P.ws
const APPS = path.join(WS, 'apps')

let server: http.Server
let baseUrl = ''
let providerId = ''
/** 端点下一次要回的项目调用；null 表示直接回文本 */
let pendingCall: { name: string; target: string; files: Array<{ path: string; content: string }> } | null = null

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseProjectCall(res: http.ServerResponse, name: string, target: string, files: unknown): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  const args = JSON.stringify({ name, target, files })
  res.write(
    part({
      tool_calls: [
        { index: 0, id: 'call_proj_1', type: 'function', function: { name: 'project_create', arguments: '' } }
      ]
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
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sse(res, `收尾：${lastText.slice(0, 120)}`)
        return
      }
      if (pendingCall) {
        const c = pendingCall
        sseProjectCall(res, c.name, c.target, c.files)
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

function startRun(
  decide: (req: ToolApprovalRequestEvent, requestId: string) => void,
  opts: { unattended?: boolean } = {}
): { promise: Promise<void>; approvals: ToolApprovalRequestEvent[]; convId: string; requestId: string } {
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: ['*'] })
  const conv = conversationRepo.create({ assistantId: asst.id, title: 'e2e', titleDefault: false })
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const approvals: ToolApprovalRequestEvent[] = []
  const emit = (channel: string, data: unknown): void => {
    if (channel !== IPC.AGENT_TOOL_APPROVAL_EVENT) return
    const req = data as ToolApprovalRequestEvent
    approvals.push(req)
    decide(req, requestId)
  }
  const promise = agentEngine.run(
    {
      requestId,
      conversationId: conv.id,
      assistantId: asst.id,
      content: '把这段写进工作目录的项目里',
      agentMode: true,
      unattended: opts.unattended,
      targets: [{ providerId, model: MODEL }]
    },
    emit
  )
  return { promise, approvals, convId: conv.id, requestId }
}

function toolRow(convId: string): string {
  return messageRepo
    .listByConversation(convId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content ?? '')
    .join('\n')
}

function projectRows(): number {
  return (dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
}

function tmpLeftovers(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'))
}

function cleanupConversation(convId: string): void {
  dbService.getHandle().prepare('DELETE FROM approval_events WHERE conversation_id = ?').run(convId)
}

const FILES = [
  { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>真机</h1></body></html>' },
  { path: 'src/app.js', content: 'console.log("ok")' }
]

describe('① 批准：审批到达时零文件，批准后才落盘', () => {
  it('弹窗字段是专用五件套；批准后目录完整、不入 projects 表', async () => {
    pendingCall = { name: 'demo', target: 'apps', files: FILES }
    fs.rmSync(APPS, { recursive: true, force: true })
    let existedWhenAsked = true
    let asked = false
    try {
      const { promise, approvals, convId } = startRun((req) => {
        asked = true
        existedWhenAsked = fs.existsSync(path.join(APPS, 'demo'))
        resolveApproval(req.approvalId, true)
      })
      await promise

      expect(asked).toBe(true)
      expect(approvals).toHaveLength(1)
      const req = approvals[0]!
      expect(req.toolName).toBe('project_create')
      expect(req.reason).toBe('PROJECT_WRITE_WORKSPACE')
      expect(req.forceConfirm).toBe(true)
      expect(req.fields?.map((f) => f.key)).toEqual([
        'project_name',
        'project_target',
        'project_stats',
        'project_files',
        'project_conflict_free'
      ])
      expect(req.fields?.[1]?.value).toBe(path.join(APPS, 'demo'))
      expect(existedWhenAsked, '审批还没点就落盘了').toBe(false)

      const dir = path.join(APPS, 'demo')
      expect(fs.existsSync(dir)).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>真机</h1>')
      expect(fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8')).toBe('console.log("ok")')
      expect(tmpLeftovers(APPS)).toEqual([])
      expect(projectRows(), '工作目录项目不该入 projects 表').toBe(0)

      const envelope = JSON.parse(toolRow(convId).split('\n').find((l) => l.includes('project_create')) ?? '{}') as {
        isError: boolean
        content: string
      }
      expect(envelope.isError).toBe(false)
      expect(JSON.parse(envelope.content)).toMatchObject({ ok: true, location: 'workspace', fileCount: 2 })
      cleanupConversation(convId)
    } finally {
      pendingCall = null
    }
  })
})

describe('② 拒绝：磁盘与库都不许动', () => {
  it('点拒绝 ⇒ 无正式目录、无 .tmp-*、无 projects 行', async () => {
    pendingCall = { name: 'denied', target: 'apps', files: FILES }
    fs.rmSync(APPS, { recursive: true, force: true })
    try {
      const { promise, approvals, convId } = startRun((req) => resolveApproval(req.approvalId, false))
      await promise

      expect(approvals).toHaveLength(1)
      expect(fs.existsSync(APPS), '拒绝后连目标父目录都不该出现').toBe(false)
      expect(tmpLeftovers(APPS)).toEqual([])
      expect(projectRows()).toBe(0)
      expect(toolRow(convId)).toContain('用户拒绝')

      const audit = dbService
        .getHandle()
        .prepare('SELECT decision FROM approval_events WHERE conversation_id = ?')
        .all(convId) as Array<{ decision: string }>
      expect(audit.map((a) => a.decision)).toContain('user_deny')
      cleanupConversation(convId)
    } finally {
      pendingCall = null
    }
  })
})

describe('③ 无人值守：不弹窗，可读失败，零残留', () => {
  it('unattended ⇒ 0 个审批事件，工具结果说"需人工确认"，目标目录不存在', async () => {
    pendingCall = { name: 'unattended', target: 'apps', files: FILES }
    fs.rmSync(APPS, { recursive: true, force: true })
    try {
      const { promise, approvals, convId } = startRun(() => {}, { unattended: true })
      await promise

      expect(approvals).toHaveLength(0)
      expect(fs.existsSync(APPS)).toBe(false)
      expect(tmpLeftovers(APPS)).toEqual([])
      expect(projectRows()).toBe(0)
      expect(toolRow(convId)).toContain('需人工确认')

      const audit = dbService
        .getHandle()
        .prepare('SELECT decision, reason_code FROM approval_events WHERE conversation_id = ?')
        .all(convId) as Array<{ decision: string; reason_code: string }>
      expect(audit).toEqual([expect.objectContaining({ decision: 'policy_deny', reason_code: 'UNATTENDED' })])
      cleanupConversation(convId)
    } finally {
      pendingCall = null
    }
  })
})

describe('④ 中止：审批悬停时 abort ⇒ 零残留', () => {
  it('审批到达后立刻 abort ⇒ 不写盘、不留 .tmp-/DB 行', async () => {
    pendingCall = { name: 'aborted', target: 'apps', files: FILES }
    fs.rmSync(APPS, { recursive: true, force: true })
    try {
      const { promise, approvals, convId, requestId } = startRun((_req, rid) => {
        agentEngine.abort(rid)
      })
      await promise.catch(() => {
        /* 中止会让运行以拒绝/抛错收尾，两种都接受 */
      })

      expect(approvals).toHaveLength(1)
      expect(fs.existsSync(APPS)).toBe(false)
      expect(tmpLeftovers(APPS)).toEqual([])
      expect(projectRows()).toBe(0)

      const audit = dbService
        .getHandle()
        .prepare('SELECT decision, reason_code FROM approval_events WHERE conversation_id = ?')
        .all(convId) as Array<{ decision: string; reason_code: string }>
      expect(audit).toEqual([expect.objectContaining({ decision: 'policy_deny', reason_code: 'ABORTED' })])
      expect(requestId).toContain('req-')
      cleanupConversation(convId)
    } finally {
      pendingCall = null
    }
  })
})
