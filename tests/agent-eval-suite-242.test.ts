// @vitest-environment node
// V4-Iter-242 的编排侧真链：一趟评测（档位 × k）在**真 SQLite + 真引擎 + 真工作目录**里跑通，
// 报告真的落盘，插队那句真的进了发给端点的那份载荷。
//
// 为什么这批量大的（十几发运行）值得留在 CI：§233 立的口径是"runner 必须被真跑一遍"，
// 而这一批新加的东西全是**编排**上的（串行、逐发目录、进度、聚合、落盘、插话时机）。
// 编排坏了，界面那颗"通过率"就是假的——假端点照本宣科地配合，正好的产物写进正好那个目录，
// 这条串得通才有资格说"数字能看"。
//
// 三处判据不是随手挑的：
//  · **会话 id 各不相同**：这是"产物留着、报告写 id"那条用户选定的口径唯一的落点证据。
//  · **插话看的是发出去的请求体**，不是看模型说了什么——它说"我听见了"不算，那条消息进没进上下文才算。
//  · **"没过"与"没跑起来"两档各造一次**（lazy 那台啥工具都不发／reject 那台直接 400）：
//    第一批数字最容易犯的错就是把接线问题算成模型问题。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-242-eval'
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
import { AGENT_EVAL_TASKS, smokeTasks, type EvalTask } from '../src/main/agent/eval/contract'
import { runEvalTask } from '../src/main/agent/eval/live'
import { agentEngine } from '../src/main/agent/engine'
import {
  agentEvalReportDir,
  describeAttempt,
  listAgentEvalReports,
  readAgentEvalReport,
  runAgentEvalSuite
} from '../src/main/agent/eval/suite'
import { AGENT_EVAL_MAX_K, type AgentEvalAttempt, type AgentEvalProgressEvent } from '../src/shared/agent-eval'

const MODEL = 'fake-obedient'
const ECHO = 'notes/echo.md'
const QUIET = 'notes/quiet.md'

let server: http.Server
let providerId = ''
let rejectProviderId = ''
/** 'obedient'=把任务办成；'lazy'=一句话都不做工具调用 */
let mode: 'obedient' | 'lazy' = 'obedient'
/** 发往端点的每一个请求体（插话有没有进上下文，就看这份清单） */
let bodies: Array<Array<{ role: string; content: unknown }>> = []

function content(m: { content: unknown }): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
}

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish?: string): void {
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n')
  if (finish) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendToolCall(res: http.ServerResponse, name: string, args: Record<string, unknown>): void {
  // 与 §231／§233 那两个 harness 同形：先报名字，再补参数
  res.write(
    'data: ' +
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name, arguments: '' } }] } }] }) +
      '\n\n'
  )
  res.write(
    'data: ' +
      JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] }) +
      '\n\n'
  )
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * 从一条工具返回里取出"文件本身的内容"。
 * 引擎把工具结果原样塞进 `role:'tool'` 的消息（外面还可能再包一层 `[工具结果]` 前缀），
 * 所以这里只认那份 JSON 里的 `content` 字段——把包装层里出现的数字（size 之类）算进乘法是假的乖。
 */
function toolFileText(raw: string): string {
  const m = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
  if (!m) return raw
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return raw
  }
}

/**
 * 一个"照本宣科的乖模型"：按**第一条用户消息**认任务，按**已有几条工具结果**认走到第几步。
 * 它不知道任务的判据是什么，只按提示词里那句话办事——所以它过了不等于产品过了，
 * 这一份用例证的是编排与判分串得通（产品质量那一档在真机那趟，见台账 §242）。
 */
function obey(res: http.ServerResponse, msgs: Array<{ role: string; content: unknown }>): void {
  if (mode === 'lazy') {
    sse(res, { content: '我想好了，但没有动手' })
    return
  }
  const ask = msgs.filter((m) => m.role === 'user')
  const first = ask.length ? content(ask[0]!) : ''
  const results = msgs.filter((m) => m.role === 'tool').length
  const echoAsked = ask.some((m) => content(m).includes(ECHO))

  if (first.includes('notes/alpha.md')) {
    if (results === 0) return sendToolCall(res, 'fs_write', { path: 'notes/alpha.md', content: 'ALPHA-OK' })
    return void sse(res, { content: '写好了' })
  }
  if (first.includes('a.txt 第三行')) {
    if (results === 0) return sendToolCall(res, 'fs_read', { path: 'a.txt' })
    return void sse(res, { content: '代号是 KILO-7' })
  }
  if (first.includes('nums.txt')) {
    if (results === 0) return sendToolCall(res, 'fs_read', { path: 'nums.txt' })
    if (results === 1) {
      // fs_read 回的是 `{path,size,content}` 那份 JSON：只认"整行是一个整数"的那些行，
      // 不然 size 那一个数字就被当成被乘数了（第一版就是这么写出 889 的）
      const text = toolFileText(content(msgs.filter((m) => m.role === 'tool')[0]!))
      const nums = (text.match(/^\s*\d+\s*$/gm) ?? []).map((s) => Number(s.trim()))
      return sendToolCall(res, 'fs_write', { path: 'out.txt', content: String(nums[0]! * nums[1]!) })
    }
    return void sse(res, { content: '算完写了' })
  }
  if (first.includes(QUIET)) {
    if (results === 0) return sendToolCall(res, 'fs_write', { path: QUIET, content: 'MILO-4' })
    // 插话那句进了上下文，才可能有第二件——这一句就是"运行中被收下"的落点
    if (echoAsked && results === 1) return sendToolCall(res, 'fs_write', { path: ECHO, content: 'MILO-4' })
    return void sse(res, { content: '两件都办好了' })
  }
  sse(res, { content: '我做完了' })
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((req, res) => {
    if (req.url?.includes('/reject')) {
      // 400 不是可重试那一档：一发就该失败收场（用它造"根本没跑起来"那一格）
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"bad request"}}')
      return
    }
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { messages?: unknown }
      const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      bodies.push(msgs)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      obey(res, msgs)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '乖模型端点',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
  rejectProviderId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '直接 400 的端点',
    baseUrl: `http://127.0.0.1:${port}/reject/v1`,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  }).id
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  mode = 'obedient'
  bodies = []
})

/** 冒烟档就是任务表里那几条，这条断言是防止有人悄悄改了档位划分后用例还在自证 */
function smokeCount(): number {
  return smokeTasks(AGENT_EVAL_TASKS).length
}

describe('① 冒烟档跑满：编排、聚合、落盘三件事各证一格', () => {
  it('4 个任务 × 2 次全部串行跑完，聚合按同一口径出数', async () => {
    const tasks = smokeCount()
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 2 })

    expect(r.attempts).toHaveLength(tasks * 2)
    expect(r.report.tasks).toBe(tasks)
    expect(r.report.k).toBe(2)
    expect(r.report.deadTasks).toBe(0)
    // 先让"哪一条没过、为什么"直接打在失败信息里：这一趟有 8 发，只说"3≠4"等于让人重跑一遍去猜
    const zero = r.report.perTask.filter((p) => p.passed === 0).map((p) => `${p.id}→${p.reasons.join('；')}`)
    expect(zero, `这几发一个都没过：${zero.join(' / ')}`).toEqual([])
    expect(r.report.everPassed).toBe(tasks)
    expect(r.report.reliable).toBe(tasks)
    expect(r.interrupted).toBe(false)
    // 每一发都被算满：perTask 的 attempts 都是 2、passAt1 都是 1
    expect(r.report.perTask.every((p) => p.attempts === 2 && p.passAt1 === 1 && p.passAllK === 1)).toBe(true)
  }, 180_000)

  it('每一发一条新会话、一个专属工作目录，产物真在盘上', async () => {
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 1 })
    const convs = new Set(r.attempts.map((a) => a.conversationId))
    const dirs = new Set(r.attempts.map((a) => a.workspaceDir))
    expect(convs.size).toBe(r.attempts.length)
    expect(dirs.size).toBe(r.attempts.length)

    const alpha = r.attempts.find((a) => a.taskId === 'write-named-file')
    expect(alpha, '冒烟档里没有 write-named-file？档位变了').toBeTruthy()
    expect(fs.readFileSync(path.join(alpha!.workspaceDir, 'notes', 'alpha.md'), 'utf-8')).toContain('ALPHA-OK')
    // 反向对照：这一发的目录里只有它自己那件产物，别发的文件不该串进来
    expect(fs.existsSync(path.join(alpha!.workspaceDir, 'out.txt'))).toBe(false)
  }, 180_000)

  it('报告落盘，清单读得到、全文读得回，逐发那行带着会话 id', async () => {
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 1 })
    expect(fs.existsSync(r.reportPath)).toBe(true)
    expect(r.reportText).toContain('Agent 评测')
    // 报告头念的是服务商**名字**（真机第一次读就发现那行是 uuid）；查不到才退回 id
    expect(r.reportText).toContain('目标：乖模型端点 · ' + MODEL)

    const list = listAgentEvalReports()
    const name = path.basename(r.reportPath)
    const entry = list.find((x) => x.fileName === name)
    expect(entry, '报告没进清单：界面那个列表就是空的').toBeTruthy()
    expect(entry!.firstLine).toContain('Agent 评测报告')
    expect(readAgentEvalReport(name)).toBe(r.reportText)
    // 用户选定"产物留着"：报告里必须点得回那一发——会话 id 是唯一的回链
    for (const a of r.attempts) expect(r.reportText).toContain(a.conversationId)
  }, 180_000)

  it('进度事件按「每发一开一收」成对推进，done 单调、total 是计划发数', async () => {
    const events: AgentEvalProgressEvent[] = []
    await runAgentEvalSuite({
      providerId,
      model: MODEL,
      tier: 'smoke',
      k: 1,
      onProgress: (e) => events.push(e)
    })
    const tasks = smokeCount()
    expect(events[0]!.total).toBe(tasks)
    expect(events.filter((e) => e.phase === 'attempt-start')).toHaveLength(tasks)
    const done = events.filter((e) => e.phase === 'attempt-done')
    expect(done).toHaveLength(tasks)
    expect(done.map((e) => e.done)).toEqual(done.map((_, i) => i + 1))
    expect(events.every((e) => e.model === MODEL && e.tier === 'smoke')).toBe(true)
  }, 180_000)
})

describe('② 插话（§238 那条通道第一次有数字）', () => {
  it('插的那句进了发给端点的载荷，第二件产物因此出现', async () => {
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 1 })
    const a = r.attempts.find((x) => x.taskId === 'interject-followup')!
    expect(a.interjection, '这一发压根没要求插话').toBeTruthy()
    expect(a.interjection!.asked).toBe(true)
    expect(a.interjection!.accepted, '引擎没收下那句，"过"就是假的').toBe(true)
    expect(a.interjection!.text).toContain(ECHO)
    expect(a.pass, a.why).toBe(true)
    expect(fs.readFileSync(path.join(a.workspaceDir, 'notes', 'echo.md'), 'utf-8')).toContain('MILO-4')

    // 判据不看它说了什么，看发出去的东西：某一发的上下文里必须有那条 user 消息
    const carried = bodies.some((msgs) =>
      msgs.some((m) => m.role === 'user' && content(m).includes(ECHO))
    )
    expect(carried, '插话没进上下文，那个"过"就是假的').toBe(true)
  }, 180_000)

  it('反向对照：没人插话时不该自己多做那件（ghost 那条判据有牙）', async () => {
    const ghost = AGENT_EVAL_TASKS.find((t) => t.id === 'interject-ghost')!
    const ws = fs.mkdtempSync(path.join(P.data, 'ghost-'))
    const r = await runEvalTask({ task: ghost, workspaceDir: ws, providerId, model: MODEL })
    expect(r.ran, r.why).toBe(true)
    expect(r.pass, r.why).toBe(true)
    // 这条任务不要求插话 ⇒ 现场里没有那条事实（不是"asked:false"的假事实）
    expect(r.interjection).toBeUndefined()
    expect(fs.existsSync(path.join(ws, 'notes', 'echo.md'))).toBe(false)
  }, 120_000)

  it('通道坏了要单独说：引擎不认这句插话时，判据不许算成"模型没听懂"', async () => {
    // 打桩只打在**通道本身**上（引擎收不收），任务、判分、证据采集全是真的——
    // 这一档在真机上对应"运行已经结束／不是主干 run"，不配一条用例就没人知道 runner 传的是哪个值
    const spy = vi.spyOn(agentEngine, 'interject').mockReturnValue(false)
    try {
      const task = AGENT_EVAL_TASKS.find((t) => t.id === 'interject-followup')!
      const ws = fs.mkdtempSync(path.join(P.data, 'interject-dead-'))
      const r = await runEvalTask({ task, workspaceDir: ws, providerId, model: MODEL })
      expect(r.ran, r.why).toBe(true)
      expect(r.interjection!.accepted).toBe(false)
      expect(r.pass).toBe(false)
      expect(r.why).toContain('没被这轮运行收下')
    } finally {
      spy.mockRestore()
    }
  }, 120_000)

  it('判据分得开"没插"与"插了但没办"', () => {
    const task = AGENT_EVAL_TASKS.find((t) => t.id === 'interject-followup')!
    const quiet = { 'notes/quiet.md': 'MILO-4' }
    const base = { workspaceFiles: quiet, toolSteps: [], finalText: '' }
    expect(task.judge({ ...base }).why).toContain('没有插话')
    expect(task.judge({ ...base, interjection: { asked: true, accepted: false, text: 'x' } }).why).toContain('没被这轮运行收下')
    expect(task.judge({ ...base, interjection: { asked: true, accepted: true, text: 'x' } }).why).toContain('notes/echo.md 没出现')
    expect(
      task.judge({
        ...base,
        workspaceFiles: { ...quiet, 'notes/echo.md': 'MILO-4' },
        interjection: { asked: true, accepted: true, text: 'x' }
      }).pass
    ).toBe(true)
    // 原本那件没办成时，插话不救：先判它
    expect(task.judge({ workspaceFiles: {}, toolSteps: [], finalText: '', interjection: { asked: true, accepted: true, text: 'x' } }).why).toContain('原本那件')
  })
})

describe('⑤ 一发的结论（2026-10-21 真机那趟撞出的自相矛盾）', () => {
  const task = { id: 't', tier: 'smoke', title: 'x', prompt: 'x', maxSteps: 6, judge: () => ({ pass: true, why: '' }) } as unknown as EvalTask
  const of = (over: Partial<AgentEvalAttempt>): AgentEvalAttempt =>
    ({
      taskId: 't',
      attempt: 1,
      tier: 'smoke',
      conversationId: 'c1',
      assistantId: 'a1',
      requestId: 'r1',
      workspaceDir: 'w1',
      approvals: 0,
      ran: true,
      pass: false,
      ...over
    } as AgentEvalAttempt)

  it('产物对但超预算：这一句要同时说清走了几步、按失败算、以及产物本身是对的', () => {
    const line = describeAttempt(task, of({ pass: true, steps: 7, why: '乘积写对了' }))
    expect(line).toContain('走了 7 步')
    expect(line).toContain('超出这条任务 6 步的预算')
    expect(line).toContain('按失败算')
    expect(line).toContain('产物本身是对的')
    // 反向对照：这句里不许出现一个孤零零的"过"（聚合那一行已经写 0%，两处必须同一个结论）
    expect(line.startsWith('没过')).toBe(true)
  })

  it('没过就是没过：不冒充超预算；超预算也不掩盖"没过"', () => {
    expect(describeAttempt(task, of({ pass: false, steps: 3, why: 'out.txt 不存在' }))).toBe('没过')
    const late = describeAttempt(task, of({ pass: false, steps: 9 }))
    expect(late).toContain('按失败算')
    expect(late).not.toContain('产物本身是对的')
  })

  it('没跑起来优先于一切；预算没定的任务不会因为步数多被判超', () => {
    expect(describeAttempt(task, of({ ran: false, pass: false, steps: 99 }))).toBe('没跑起来')
    const noBudget = { ...task, maxSteps: undefined } as EvalTask
    expect(describeAttempt(noBudget, of({ pass: true, steps: 40 }))).toBe('过')
    // 查不到任务形状时也不许编一个"超预算"出来
    expect(describeAttempt(undefined, of({ pass: true, steps: 40 }))).toBe('过')
  })
})

describe('③ 「没过」与「没跑起来」是两格，不许混', () => {
  it('端点直接 400 ⇒ 每一发都是 ran=false，deadTasks 才该是满的', async () => {
    const r = await runAgentEvalSuite({ providerId: rejectProviderId, model: MODEL, tier: 'smoke', k: 1 })
    expect(r.attempts.every((a) => a.ran === false && a.pass === false)).toBe(true)
    expect(r.attempts.every((a) => (a.why ?? '').startsWith('没跑起来'))).toBe(true)
    expect(r.report.deadTasks).toBe(r.report.tasks)
    expect(r.report.reliable).toBe(0)
    // 这一档不算进 pass@1 的分母：perTask 的 passAt1 必须是 0 而不是"看不出"
    expect(r.report.perTask.every((p) => p.passAt1 === 0 && p.notRan === 1)).toBe(true)
  }, 120_000)

  it('模型一句话都不动手 ⇒ ran=true、pass=false，deadTasks 必须还是 0', async () => {
    mode = 'lazy'
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 1 })
    expect(r.attempts.every((a) => a.ran === true)).toBe(true)
    expect(r.report.deadTasks).toBe(0)
    expect(r.report.everPassed).toBe(0)
    expect(r.report.reliable).toBe(0)
    // 插话那一发：跑得起来、但两件产物都没有，原因来自判据而不是"没跑起来"
    const a = r.attempts.find((x) => x.taskId === 'interject-followup')!
    expect(a.why).toContain('原本那件')
  }, 120_000)
})

describe('④ 档位与提前收口', () => {
  it('k 超上限被夹到 AGENT_EVAL_MAX_K；一开始就喊停＝0 发，但报告仍说实话', async () => {
    const r = await runAgentEvalSuite({
      providerId,
      model: MODEL,
      tier: 'smoke',
      k: AGENT_EVAL_MAX_K + 99,
      stopped: () => true
    })
    expect(r.k).toBe(AGENT_EVAL_MAX_K)
    expect(r.attempts).toHaveLength(0)
    expect(r.stoppedEarly).toBe(true)
    expect(r.interrupted).toBe(true)
    expect(r.reportText).toContain('被中途喊停')
    // 没跑满 ⇒ 一个任务都没进聚合，不许把"计划 20 发"读成"跑了 20 发全过"
    expect(r.report.tasks).toBe(0)
  }, 60_000)

  it('跑了两发再喊停：只留那两发，pass^k 按没跑满算 0', async () => {
    let opened = 0
    const r = await runAgentEvalSuite({
      providerId,
      model: MODEL,
      tier: 'smoke',
      k: 3,
      stopped: () => opened >= 2,
      onAttemptStarted: () => {
        opened++
      }
    })
    // 第 1、2 发开跑，第 3 发开跑前被拦下：于是只有第一个任务报了数，而且它没跑满 k
    expect(r.attempts.map((a) => `${a.taskId}#${a.attempt}`)).toEqual(['write-named-file#1', 'write-named-file#2'])
    expect(r.stoppedEarly).toBe(true)
    expect(r.report.tasks).toBe(1)
    // "跑不满一律 0"是 §233 立的口径，这一格就是它在这个批次里的落点
    expect(r.report.perTask[0]!.passAllK).toBe(0)
    expect(r.report.perTask[0]!.attempts).toBe(2)
    expect(r.reportText).toContain('被中途喊停')
  }, 180_000)

  it('服务层那道报告名形状闸自己站得住（桥层有 zod 挡在前头，不等于它可以缺）', async () => {
    const r = await runAgentEvalSuite({ providerId, model: MODEL, tier: 'smoke', k: 1 })
    const name = path.basename(r.reportPath)
    // 正向对照：清单里那份真读得回来
    expect(readAgentEvalReport(name)).toContain('Agent 评测报告')
    // 反向必须打到一份**真存在**的文件上：第一版我写的两条穿越都落在不存在的路径，
    // "不存在所以拒"与"形状不合所以拒"算出同一个数，把闸门整条摘掉用例照样全绿（假绿，见台账 §242）
    const outside = path.join(agentEvalReportDir(), '..', 'leak-242.md')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, '这一份在评测目录外面，不该被这条通道读到', 'utf-8')
    for (const bad of ['../leak-242.md', '..' + path.sep + 'leak-242.md', 'sub/' + name]) {
      expect(() => readAgentEvalReport(bad), bad).toThrow(/EVAL_REPORT_NOT_FOUND/)
    }
    // 正向对照之二：那份文件本身是读得到的（证明上面那句拒不是因为路径根本不存在）
    expect(fs.readFileSync(outside, 'utf-8')).toContain('不该被这条通道读到')
  }, 120_000)

  it('全量档才是那 8 条：冒烟档不许把贵的几条拖进默认档', () => {
    expect(AGENT_EVAL_TASKS.length).toBe(8)
    expect(smokeCount()).toBe(4)
    expect(AGENT_EVAL_TASKS.filter((t) => t.interject).map((t) => t.id)).toEqual(['interject-followup'])
  })
})
