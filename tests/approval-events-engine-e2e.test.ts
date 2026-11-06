// @vitest-environment node
// 审批「决定 → approval_events」整链（P0-2c-1 补证）：真临时库 + 真迁移 + 真 repo + 真引擎循环 + 真本地端点。
//
// 之前这条链只有两段各测各的：`tool-approval-audit.test.ts` 钉「决定 → 审计载荷」映射，
// `approval-events-real-db.test.ts` 钉 repo 落库。中间那一步——引擎把 `recordApprovalDecision`
// 塞进 `createApproval` 的 audit 上下文（engine.ts:2281）——没有执行层证据。
// 这里按 `agent-fs-write-approval-chain-231.test.ts` 的形状把它接起来：桩掉的只有 portable 与 logger。
//
// 覆盖五档：user_approve / user_deny / timeout_deny / auto_allow / policy_deny
// （policy_deny 两处调用点都走：engine.ts:2196 分类拒绝、engine.ts:2231 无人值守）。
//
// 超时那一档不真等 5 分钟：把 `setTimeout(…, APPROVAL_TIMEOUT_MS)` 这一条延迟改成 30ms，
// 走的仍是 createApproval 里同一个 settle(false,'timeout') 分支；不改生产代码。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-approval-engine-e2e'
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
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { agentEngine } from '../src/main/agent/engine'
import {
  APPROVAL_TIMEOUT_MS,
  resetApprovalStateForTest,
  resolveApproval,
  toolArgsFingerprint
} from '../src/main/agent/tool-approval'
import { IPC, type ToolApprovalRequestEvent } from '../src/shared/types'

const MODEL = 'fake-approval-toolcall'
const WS = path.join(P.dir, 'workspace')
const REL = 'notes/audit.md'

let server: http.Server
let baseUrl = ''
let providerId = ''
let assistantId = ''
let seq = 0
/** 端点下一步要回的工具调用；null 表示直接回文本收尾 */
let nextCall: { name: string; argsJson: string } | null = null

interface ApprovalRow {
  request_id: string
  conversation_id: string
  assistant_id: string | null
  step_index: number | null
  tool_call_id: string | null
  tool_id: string
  tool_name: string
  decision: string
  reason_code: string | null
  scope: string
  args_digest: string | null
  args_redacted: string | null
  actor: string
  requested_at: number
  decided_at: number
  created_at: number
}

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseToolCall(res: http.ServerResponse, name: string, argsJson: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(
    part({
      tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }]
    })
  )
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: argsJson } }] }))
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
  // 工作目录一设，fs_write 才注册（确认档），引擎才会走到 createApproval
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
      // 工具结果回来后一律收尾：这一批只关心第一轮的决定有没有落库
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sse(res, `收尾：${lastText.slice(0, 80)}`)
        return
      }
      if (nextCall) {
        sseToolCall(res, nextCall.name, nextCall.argsJson)
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
    name: '审批端点探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id

  assistantId = assistantRepo.save({ name: '审批整链助手', toolPermissions: ['*'] }).id
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

beforeEach(() => {
  dbService.getHandle().prepare('DELETE FROM approval_events').run()
  resetApprovalStateForTest()
})

function rowsOf(convId: string): ApprovalRow[] {
  return dbService
    .getHandle()
    .prepare(`SELECT * FROM approval_events WHERE conversation_id = ? ORDER BY rowid`)
    .all(convId) as ApprovalRow[]
}

/**
 * 起一轮真引擎。`onApproval` 在审批事件到达的当下执行（可同步点允许/拒绝），
 * 不传就让它挂着——超时用例靠这一点。
 */
async function runAgent(opts: {
  call: { name: string; argsJson: string } | null
  convId?: string
  unattended?: boolean
  onApproval?: (req: ToolApprovalRequestEvent) => void
}): Promise<{
  convId: string
  approvals: ToolApprovalRequestEvent[]
  startedAt: number
  settledAt: number
}> {
  nextCall = opts.call
  const convId =
    opts.convId ??
    conversationRepo.create({ assistantId, title: `审批整链-${seq}`, titleDefault: false }).id
  const approvals: ToolApprovalRequestEvent[] = []
  const emit = (channel: string, data: unknown): void => {
    if (channel !== IPC.AGENT_TOOL_APPROVAL_EVENT) return
    const req = data as ToolApprovalRequestEvent
    approvals.push(req)
    opts.onApproval?.(req)
  }
  const startedAt = Date.now()
  try {
    await agentEngine.run(
      {
        requestId: `req-approval-${Date.now()}-${seq++}`,
        conversationId: convId,
        assistantId,
        content: '按计划执行',
        agentMode: true,
        unattended: opts.unattended,
        targets: [{ providerId, model: MODEL }]
      },
      emit
    )
  } finally {
    nextCall = null
  }
  return { convId, approvals, startedAt, settledAt: Date.now() }
}

/**
 * 只把「审批等待」这一条定时器缩短。
 *
 * 注意引擎里有**两条** 5 分钟定时器：setup 阶段先建的整体循环超时（LOOP_TIMEOUT_MS）与
 * createApproval 后建的审批等待（APPROVAL_TIMEOUT_MS），两个值都等于 5 分钟。
 * 若按延迟值一刀切，整轮会先被循环超时 abort，落库变成 policy_deny/ABORTED——
 * 这里按「本次 run 里第 2 次出现的 5 分钟定时器」定位审批那条，其余原样透传。
 * createApproval 的 settle(false,'timeout') 分支因此被真跑一次，不改生产代码。
 */
function shortenApprovalTimeout(): () => void {
  const original = globalThis.setTimeout
  let longTimers = 0
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((((fn: (...a: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === APPROVAL_TIMEOUT_MS) {
      longTimers += 1
      if (longTimers >= 2) return original(fn, 30, ...args)
    }
    return original(fn, delay, ...args)
  }) as unknown) as typeof setTimeout)
  return () => spy.mockRestore()
}

describe('用户批准：决定 → 真表落库', () => {
  it('批准后写一条 user_approve/once/USER_APPROVE，字段与请求参数对得上，文件真的落盘', async () => {
    fs.rmSync(path.join(WS, REL), { force: true })
    const args = { path: REL, content: '批准后写入\n' }
    const argsJson = JSON.stringify(args)

    const { convId, approvals, startedAt, settledAt } = await runAgent({
      call: { name: 'fs_write', argsJson },
      onApproval: (req) => resolveApproval(req.approvalId, true)
    })

    expect(approvals, 'fs_write 是确认档，必须弹一次审批').toHaveLength(1)
    const rows = rowsOf(convId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      decision: 'user_approve',
      scope: 'once',
      reason_code: 'USER_APPROVE',
      tool_id: 'fs_write',
      tool_name: 'fs_write',
      assistant_id: assistantId,
      tool_call_id: 'call_1',
      actor: 'local_user',
      args_digest: toolArgsFingerprint(argsJson)
    })
    // 落库的是脱敏摘要，内容与请求参数一致（这条不含密钥）
    expect(JSON.parse(String(row.args_redacted))).toEqual(args)
    expect(row.requested_at).toBeGreaterThanOrEqual(startedAt)
    expect(row.decided_at).toBeGreaterThanOrEqual(row.requested_at)
    expect(row.decided_at).toBeLessThanOrEqual(settledAt)
    expect(fs.readFileSync(path.join(WS, REL), 'utf-8')).toBe(args.content)
  })
})

describe('用户拒绝：决定 → 真表落库', () => {
  it('拒绝后写一条 user_deny/once/USER_DENY，且工具没执行', async () => {
    fs.rmSync(path.join(WS, REL), { force: true })
    const args = { path: REL, content: '不该落盘\n' }

    const { convId, approvals, startedAt, settledAt } = await runAgent({
      call: { name: 'fs_write', argsJson: JSON.stringify(args) },
      onApproval: (req) => resolveApproval(req.approvalId, false)
    })

    expect(approvals).toHaveLength(1)
    const rows = rowsOf(convId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      decision: 'user_deny',
      scope: 'once',
      reason_code: 'USER_DENY',
      args_digest: toolArgsFingerprint(JSON.stringify(args))
    })
    expect(JSON.parse(String(row.args_redacted))).toEqual(args)
    expect(row.requested_at).toBeGreaterThanOrEqual(startedAt)
    expect(row.decided_at).toBeGreaterThanOrEqual(row.requested_at)
    expect(row.decided_at).toBeLessThanOrEqual(settledAt)
    expect(fs.existsSync(path.join(WS, REL))).toBe(false)
  })
})

describe('超时：决定 → 真表落库，且 settle 幂等', () => {
  it('无人应答 ⇒ timeout_deny/once/TIMEOUT；之后再点批准不补写第二条', async () => {
    fs.rmSync(path.join(WS, REL), { force: true })
    const args = { path: REL, content: '超时不该写\n' }
    const restore = shortenApprovalTimeout()
    let approvalId = ''
    try {
      const { convId, approvals } = await runAgent({
        call: { name: 'fs_write', argsJson: JSON.stringify(args) },
        onApproval: (req) => {
          approvalId = req.approvalId
        }
      })

      expect(approvals, '超时前审批事件必须已经广播出去').toHaveLength(1)
      const rows = rowsOf(convId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        decision: 'timeout_deny',
        scope: 'once',
        reason_code: 'TIMEOUT',
        args_digest: toolArgsFingerprint(JSON.stringify(args))
      })
      expect(JSON.parse(String(rows[0]!.args_redacted))).toEqual(args)
      expect(rows[0]!.decided_at).toBeGreaterThanOrEqual(rows[0]!.requested_at)
      expect(fs.existsSync(path.join(WS, REL))).toBe(false)

      // settle 幂等：已超时收尾，再来一个用户批准必须匹配不到、也不许追加第二条
      expect(resolveApproval(approvalId, true)).toBe(false)
      expect(resolveApproval(approvalId, false)).toBe(false)
      expect(rowsOf(convId)).toHaveLength(1)
    } finally {
      restore()
    }
  })
})

describe('自动放行（会话白名单）：决定 → 真表落库', () => {
  it('首次批准勾「总是允许」⇒ user_approve/session；同会话同参数再来一次 ⇒ auto_allow/session，且不再弹窗', async () => {
    fs.rmSync(path.join(WS, REL), { force: true })
    const args = { path: REL, content: '白名单放行\n' }
    const argsJson = JSON.stringify(args)

    const first = await runAgent({
      call: { name: 'fs_write', argsJson },
      onApproval: (req) => resolveApproval(req.approvalId, true, true)
    })
    expect(first.approvals).toHaveLength(1)

    const second = await runAgent({ call: { name: 'fs_write', argsJson }, convId: first.convId })
    expect(second.approvals, '命中会话白名单后不该再弹窗').toHaveLength(0)

    const rows = rowsOf(first.convId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ decision: 'user_approve', scope: 'session', reason_code: 'USER_APPROVE' })
    expect(rows[1]).toMatchObject({ decision: 'auto_allow', scope: 'session', reason_code: 'SESSION_ALLOW' })
    expect(rows[1]!.args_digest).toBe(toolArgsFingerprint(argsJson))
    expect(rows[1]!.decided_at).toBeGreaterThanOrEqual(rows[1]!.requested_at)
  })
})

describe('policy_deny：分类拒绝走 engine.ts:2196，且参数密钥被脱敏', () => {
  it('未知工具 ⇒ policy_deny/once/UNKNOWN_TOOL；apiKey 与 Bearer 在 args_redacted 里都必须消失', async () => {
    const apiKey = 'sk-live-ABC123SECRET'
    const bearer = 'tok-7f8e9dTOKEN'
    const argsJson = JSON.stringify({
      apiKey,
      command: `curl -H "Authorization: Bearer ${bearer}" https://example.com`
    })

    const { convId, approvals } = await runAgent({ call: { name: 'ghost_tool', argsJson } })

    expect(approvals, '分类拒绝不该弹审批').toHaveLength(0)
    const rows = rowsOf(convId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      decision: 'policy_deny',
      scope: 'once',
      reason_code: 'UNKNOWN_TOOL',
      tool_name: 'ghost_tool',
      tool_id: 'ghost_tool',
      args_digest: toolArgsFingerprint(argsJson)
    })
    expect(row.args_redacted, '原始密钥不许进库').not.toContain(apiKey)
    expect(row.args_redacted).not.toContain(bearer)
    expect(row.args_redacted).toContain('[redacted]')
  })
})

describe('policy_deny：无人值守走 engine.ts:2231', () => {
  it('unattended 下的确认档工具 ⇒ policy_deny/once/UNATTENDED，不弹窗也不执行', async () => {
    fs.rmSync(path.join(WS, REL), { force: true })
    const args = { path: REL, content: '子代理不该写\n' }

    const { convId, approvals } = await runAgent({
      call: { name: 'fs_write', argsJson: JSON.stringify(args) },
      unattended: true
    })

    expect(approvals, '无人值守不该弹审批').toHaveLength(0)
    const rows = rowsOf(convId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      decision: 'policy_deny',
      scope: 'once',
      reason_code: 'UNATTENDED',
      args_digest: toolArgsFingerprint(JSON.stringify(args))
    })
    expect(JSON.parse(String(rows[0]!.args_redacted))).toEqual(args)
    expect(fs.existsSync(path.join(WS, REL))).toBe(false)
  })
})
