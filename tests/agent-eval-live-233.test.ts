// @vitest-environment node
// V4-Iter-233 的**运行侧**：评测 runner 必须被真跑一遍，否则"我们有一套评测集"这句话没人验证过。
//
// CI 里怎么跑真：真 SQLite + 真 `agentEngine.run` + 真本地 SSE 端点（一个照本宣科的假模型）+ 真工作目录读写。
// 假模型只用来把"任务被办成 / 办歪 / 端点根本没连上"三种现场喂给判分器——**测的是 runner 与判分，不是模型能力**，
// 所以这里的通过数不代表产品质量（那要真机那一趟，见台账 §233 的"未做"段）。
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-233-eval'
  const appRoot = dir + sep + 'app'
  process.env.POCKETAI_APP_ROOT = appRoot
  return { dir, appRoot, db: dir + sep + 'app.db', data: appRoot + sep + 'data' }
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
import { aggregateSuite, AGENT_EVAL_TASKS, type AttemptOutcome } from '../src/main/agent/eval/contract'
import { runEvalTask, stageTaskSetup } from '../src/main/agent/eval/live'
import type { AgentTraceRecord } from '../src/shared/types'

const MODEL = 'fake-obedient'
const taskOf = (id: string) => {
  const t = AGENT_EVAL_TASKS.find((x) => x.id === id)
  if (!t) throw new Error(`任务表里没有 ${id}`)
  return t
}

let server: http.Server
let providerId = ''
/** 假模型下一次要发的工具调用（null=直接给文本收尾） */
let scripted: Array<{ name: string; args: Record<string, unknown> }> | null = null
/** 假模型收尾时给出的文本 */
let scriptedText = '完成了'

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish = 'stop'): void {
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n')
  if (finish) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
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
      const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      const last = msgs[msgs.length - 1]
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sse(res, { content: scriptedText })
        return
      }
      if (scripted && scripted.length > 0) {
        const part = (d: unknown): void => {
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n')
        }
        // 每个调用两段：先报名字（参数留空），再补参数——与 §231/§232 那两个真链 harness 同一形状
        scripted.forEach((call, i) => {
          part({
            tool_calls: [{ index: i, id: `c${i}`, type: 'function', function: { name: call.name, arguments: '' } }]
          })
          part({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(call.args) } }] })
        })
        part({ finish_reason: 'tool_calls' })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      sse(res, { content: scriptedText })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '假模型端点',
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

/** 这一份文件每跑一次建 6 个工作目录；此前只建不删，%TEMP% 里攒过 144 个（V4-Iter-248） */
const workspaces: string[] = []

afterEach(() => {
  while (workspaces.length > 0) {
    const d = workspaces.pop()
    if (d) fs.rmSync(d, { recursive: true, force: true })
  }
})

function freshWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-233-ws-'))
  workspaces.push(d)
  return d
}

describe('① 任务办成那一档', () => {
  it('runner 真把工作目录、confirm 放行、证据采集、判分串起来', async () => {
    const task = taskOf('write-named-file')
    const ws = freshWorkspace()
    scripted = [{ name: 'fs_write', args: { path: 'notes/alpha.md', content: 'ALPHA-OK' } }]
    scriptedText = '已经写好了'
    const r = await runEvalTask({ task, workspaceDir: ws, providerId, model: MODEL })

    expect(r.ran, r.why).toBe(true)
    expect(r.pass).toBe(true)
    // §231 之后 fs_write 是 confirm 档：runner 没自动放行就一律过不了，这一格就是那件事的证据
    expect(r.approvals, '一次 confirm 都没被放行').toBeGreaterThan(0)
    expect(fs.readFileSync(path.join(ws, 'notes', 'alpha.md'), 'utf-8')).toContain('ALPHA-OK')
    expect(r.steps).toBeGreaterThan(0)
    expect(r.tokens).toBeGreaterThanOrEqual(0)
  })

  it('setup 真的先落盘（自变量在环境里，不在提示词里）', () => {
    const task = taskOf('read-then-answer')
    const ws = freshWorkspace()
    stageTaskSetup(ws, task)
    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf-8')).toContain('KILO-7')
  })

  it('读文件后答出代号：文本判据那一类也走得通', async () => {
    const task = taskOf('read-then-answer')
    const ws = freshWorkspace()
    scripted = [{ name: 'fs_read', args: { path: 'a.txt' } }]
    scriptedText = '代号是 KILO-7'
    const r = await runEvalTask({ task, workspaceDir: ws, providerId, model: MODEL })
    expect(r.ran, r.why).toBe(true)
    expect(r.pass).toBe(true)
  })
})

describe('② 办歪与跑不起来必须分两档报', () => {
  it('文件写了但标记不对 ⇒ ran=true、pass=false，原因来自判分器', async () => {
    const task = taskOf('write-named-file')
    const ws = freshWorkspace()
    scripted = [{ name: 'fs_write', args: { path: 'notes/alpha.md', content: '我写了点别的' } }]
    scriptedText = '写好了'
    const r = await runEvalTask({ task, workspaceDir: ws, providerId, model: MODEL })
    expect(r.ran).toBe(true)
    expect(r.pass).toBe(false)
    expect(r.why).toContain('没有标记')
  })

  it('端点连不上 ⇒ ran=false 且不算通过（也不许被算成 pass）', async () => {
    const task = taskOf('write-named-file')
    const ws = freshWorkspace()
    scripted = null
    const dead = providerRepo.save({
      id: '',
      type: 'openai-compatible',
      name: '不存在的端点',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKeys: [],
      models: [MODEL],
      enabled: true,
      createdAt: Date.now()
    }).id
    const r = await runEvalTask({ task, workspaceDir: ws, providerId: dead, model: MODEL })
    expect(r.ran).toBe(false)
    expect(r.pass).toBe(false)
    // 引擎把失败咽成 `AGENT_ERROR_EVENT` 而不是抛异常 ⇒ runner 要看事件才分得出这一档（原因原样带出）
    expect(r.why).toContain('没跑起来')
    // 工作目录里什么都没写：跑不起来时不许留半成品
    expect(fs.existsSync(path.join(ws, 'notes'))).toBe(false)
  })

  it('聚合那一栏真的把两档分开（deadTasks 与 pass@1 分母各算各的）', () => {
    const task = taskOf('write-named-file')
    const outcomes = new Map<string, AttemptOutcome[]>([
      [task.id, [{ ran: false, pass: false }, { ran: true, pass: true, steps: 2 }]]
    ])
    const r = aggregateSuite([task], 2, outcomes)
    const p = r.perTask[0]!
    expect(p.notRan).toBe(1)
    expect(p.passAt1).toBe(1)
    expect(p.passAllK).toBe(0)
  })
})

describe('③ trace 那三列在评测这一趟里也在写（V4-Iter-232 的列不是摆设）', () => {
  it('一次评测运行的 tools 步骤里能查到参数、返回值与模型名', async () => {
    const task = taskOf('write-named-file')
    const ws = freshWorkspace()
    scripted = [{ name: 'fs_write', args: { path: 'notes/gamma.md', content: 'ALPHA-OK' } }]
    scriptedText = '好了'
    const r = await runEvalTask({ task, workspaceDir: ws, providerId, model: MODEL })
    expect(r.ran, r.why).toBe(true)
    // 最近一次 request 的 trace 就在库里：取该会话最新一次运行的分步
    const traces = latestTracesOf(ws)
    const toolsStep = traces.find((t) => t.stepType === 'tools')
    expect(toolsStep, '这趟评测没写出 tools 步骤的 trace').toBeTruthy()
    expect(toolsStep!.toolArgs).toContain('notes/gamma.md')
    expect(toolsStep!.model).toBe(MODEL)
  })
})

/** 取库里最近一次运行的全部 trace（评测每跑一次就是一趟新 request） */
function latestTracesOf(_ws: string): AgentTraceRecord[] {
  const rows = dbService
    .getHandle()
    .prepare(
      `SELECT * FROM agent_traces WHERE request_id = (
         SELECT request_id FROM agent_traces ORDER BY created_at DESC, rowid DESC LIMIT 1
       ) ORDER BY step_index ASC`
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    requestId: String(row.request_id),
    conversationId: String(row.conversation_id),
    stepIndex: Number(row.step_index),
    stepType: String(row.step_type) as AgentTraceRecord['stepType'],
    toolName: (row.tool_name as string | null) ?? undefined,
    durationMs: (row.duration_ms as number | null) ?? undefined,
    tokenUsage: (row.token_usage as number | null) ?? undefined,
    status: String(row.status) as AgentTraceRecord['status'],
    error: (row.error as string | null) ?? undefined,
    toolArgs: (row.tool_args as string | null) ?? undefined,
    toolResult: (row.tool_result as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    createdAt: Number(row.created_at)
  }))
}
