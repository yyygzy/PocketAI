// @vitest-environment node
// V4-Iter-238 的接线证据：运行中插队的那句话**真的进了下一轮的上下文**，而且落库了。
//
// 形状复用 §234／§232：真 SQLite + 真引擎循环 + 真本地 SSE 端点。判据取两处**互相独立**的证据：
//  · 发给端点的那一份载荷（模型真的看得见这句话——只落库不算送到）；
//  · messages 表里的用户行（切开会话再回来还在——只进上下文不算存下）。
// 两条各挡一种半截实现：只在渲染层乐观显示＝两条都没有；只写库不推 messages＝有库没有载荷。
//
// 另外三条是本批真正的风险：
//  ① 插队点只能落在步与步之间，且必须排在 `assistant.tool_calls` 与它的 `tool` 应答**之后**
//     （插在那中间，严格 OpenAI 兼容端会按畸形请求拒掉，整轮失败）；
//  ② 点「立即」不是中止：同一轮照样跑完、DONE 照发、会话状态是 done；
//  ③ 最后一步之后才交进来的插队**不会被消费**——引擎不假装收下了它（渲染层靠 DONE 把它归回队列）。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-238-chain'
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
import { agentEngine } from '../src/main/agent/engine'
import { IPC, type AgentDoneEvent, type AgentErrorEvent, type AgentStepEvent } from '../src/shared/types'

const MODEL = 'fake-interject'
const TOOL_NAME = 'time.now'

let server: http.Server
let providerId = ''

/** 每一次发给端点的**主推理步**载荷（带 system 的那一发；摘要与标题那两发不计） */
let bodies: Record<string, unknown>[] = []
/** 主步开始前要做的事（测试在这里点「立即插队」），返回 Promise 会先把回话压住 */
let onMainStep: ((step: number) => void | Promise<void>) | null = null
/** 第几次主步要回 tool_call（其余回最终回答） */
let toolAtSteps = new Set<number>()

function sseText(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseToolCall(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown): string => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(
    part({
      tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } }]
    })
  )
  res.write(part({ finish_reason: 'tool_calls' }))
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
      const msgs = (body.messages ?? []) as { role: string }[]
      // 摘要／标题那一发没有 system，回一句短的即可（本批没种历史，正常情况下走不到）
      if (!msgs.some((m) => m.role === 'system')) {
        sseText(res, '摘要：无要点')
        return
      }
      bodies.push(body)
      const step = bodies.length
      Promise.resolve(onMainStep?.(step))
        .catch(() => {})
        .then(() => {
          if (toolAtSteps.has(step)) sseToolCall(res)
          else sseText(res, `收尾回答-${step}`)
        })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '插队探针',
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

interface RunOut {
  conversationId: string
  requestId: string
  events: AgentStepEvent[]
  done: AgentDoneEvent | null
  error: AgentErrorEvent | null
}

interface Interject {
  /** 在第几次主推理步的进行中点「立即插队」（1 = 第一轮请求还没回话时） */
  atStep: number
  clientRef: string
  text: string
}

interface RunOut {
  conversationId: string
  requestId: string
  events: AgentStepEvent[]
  done: AgentDoneEvent | null
  error: AgentErrorEvent | null
}

/** 跑一轮：脚本 = 哪几步回 tool_call + 哪一步进行中点「立即插队」 */
async function runOne(opts: {
  content: string
  toolAt?: number[]
  interject?: Interject[]
  asChild?: boolean
}): Promise<RunOut> {
  bodies = []
  toolAtSteps = new Set(opts.toolAt ?? [])
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: [TOOL_NAME] })
  const conversationId = conversationRepo.create({
    assistantId: asst.id,
    title: '插队',
    titleDefault: false
  }).id
  const requestId = `req-238-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  // 引擎的收件箱按 requestId 收；插队发生在**端点回话之前**，等价于用户在流式那几秒里点了「立即」
  onMainStep = (step) => {
    for (const it of opts.interject ?? []) {
      if (it.atStep !== step) continue
      const accepted = agentEngine.interject(requestId, it.clientRef, it.text)
      interjectResults.push({ clientRef: it.clientRef, accepted })
    }
  }
  const events: AgentStepEvent[] = []
  let done: AgentDoneEvent | null = null
  let error: AgentErrorEvent | null = null
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_STEP_EVENT) events.push(data as AgentStepEvent)
    else if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    else if (channel === IPC.AGENT_ERROR_EVENT) error = data as AgentErrorEvent
  }
  await agentEngine.run(
    {
      requestId,
      conversationId,
      assistantId: asst.id,
      content: opts.content,
      agentMode: true,
      targets: [{ providerId, model: MODEL }]
    },
    emit,
    opts.asChild ? { asChild: true } : undefined
  )
  onMainStep = null
  return { conversationId, requestId, events, done, error }
}

/** 「点立即时引擎接不接」的记录，由 runOne 写、用例读 */
let interjectResults: Array<{ clientRef: string; accepted: boolean }> = []
beforeEach(() => {
  interjectResults = []
})

const messagesOf = (body: Record<string, unknown>): { role: string; content: unknown; tool_call_id?: string }[] =>
  (body.messages ?? []) as { role: string; content: unknown; tool_call_id?: string }[]

const textOf = (m: { content: unknown }): string =>
  typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')

describe('① 步边界消费：插队那句话既进载荷也进库', () => {
  it('第一步进行中点「立即」⇒ 第二次请求末尾就是这句话，顺序排在 tool 应答之后，库里有对应行，DONE 照发', async () => {
    const out = await runOne({
      content: '任务开始',
      toolAt: [1],
      interject: [{ atStep: 1, clientRef: 'ref-a', text: '插队一句' }]
    })
    expect(interjectResults).toEqual([{ clientRef: 'ref-a', accepted: true }])
    expect(bodies, '这一步没发给端点').toHaveLength(2)

    // 证据 A —— 模型真的看得见：第二次请求的最后一条就是那句话（不是被塞在中间）
    const msgs = messagesOf(bodies[1]!)
    const text = msgs.map(textOf)
    expect(text[text.length - 1]).toBe('插队一句')
    expect(msgs[msgs.length - 1]!.role).toBe('user')

    // 顺序不变量：assistant.tool_calls → tool 应答 → 插队句，谁也不能插到前两条中间
    const toolIdx = msgs.findIndex((m) => m.role === 'tool')
    expect(toolIdx, '第二次请求里没有 tool 应答（这一步没真跑工具？）').toBeGreaterThan(-1)
    const interIdx = msgs.length - 1
    expect(interIdx).toBeGreaterThan(toolIdx)
    const earlyInterject = msgs.slice(0, toolIdx).some((m) => m.role === 'user' && textOf(m) === '插队一句')
    expect(
      earlyInterject,
      '插队句被塞到 assistant.tool_calls 与它的 tool 应答之间（严格端点会按畸形请求拒）'
    ).toBe(false)

    // 证据 B —— 库里也有这一行，且排在第一步的助手回复之前、最终回答之后（切走再回来顺序不错）
    const dbMsgs = messageRepo.listByConversation(out.conversationId)
    const dbIdx = dbMsgs.findIndex((m) => m.role === 'user' && m.content === '插队一句')
    expect(dbIdx, '插队句没有落成 messages 表的用户行').toBeGreaterThanOrEqual(0)
    expect(dbMsgs[0]!.content).toBe('任务开始')

    // 事件把 DB id 与 clientRef 一起带回来（渲染层靠它把排队项换成用户卡）
    const evt = out.events.find((e) => e.type === 'interject')
    expect(evt, '没有发出 interject 事件').toBeTruthy()
    expect(evt!.clientRef).toBe('ref-a')
    expect(evt!.messageId).toBe(dbMsgs[dbIdx]!.id)

    // 判据②：点立即不是中止 —— 同一轮照样跑完，DONE 在、ERROR 不在、会话状态是 done
    expect(out.error, `这一轮被弄成失败了：${out.error?.error}`).toBeNull()
    expect(out.done, '没有 DONE').not.toBeNull()
    // 3 步 = llm(出 tool_call) → tools(跑 time.now) → llm(收尾)：工具那一步也计数
    expect(out.done!.stepCount).toBe(3)
    const finalIdx = dbMsgs.findIndex((m) => m.role === 'assistant' && m.content.includes('收尾回答-2'))
    expect(finalIdx, '最终回答没落库').toBeGreaterThan(dbIdx)
  })

  it('同一步边界收到两条 ⇒ 按到达顺序连着进上下文，各落一行', async () => {
    const out = await runOne({
      content: '任务开始',
      toolAt: [1],
      interject: [
        { atStep: 1, clientRef: 'ref-1', text: '第一句' },
        { atStep: 1, clientRef: 'ref-2', text: '第二句' }
      ]
    })
    const msgs = messagesOf(bodies[1]!)
    const text = msgs.map(textOf)
    expect(text.slice(-2)).toEqual(['第一句', '第二句'])
    const db = messageRepo.listByConversation(out.conversationId)
    expect(db.filter((m) => m.role === 'user' && ['第一句', '第二句'].includes(m.content)).map((m) => m.content))
      .toEqual(['第一句', '第二句'])
    expect(out.events.filter((e) => e.type === 'interject').map((e) => e.clientRef)).toEqual(['ref-1', 'ref-2'])
    expect(out.error).toBeNull()
  })
})

describe('② 没被消费的插队：引擎不假装收下', () => {
  it('最后一次主步进行中点「立即」⇒ 运行结束时它没有落库（渲染层靠 DONE 把它归回队列）', async () => {
    const out = await runOne({
      content: '任务开始',
      // 只有一步，且这一步回最终回答 ⇒ 交进来的那句话没有下一个步边界可消费
      interject: [{ atStep: 1, clientRef: 'ref-late', text: '来不及的那句' }]
    })
    expect(interjectResults).toEqual([{ clientRef: 'ref-late', accepted: true }])
    expect(out.done, '这一轮该正常跑完').not.toBeNull()
    const db = messageRepo.listByConversation(out.conversationId)
    expect(db.some((m) => m.content === '来不及的那句'), '没消费的插队不该落库').toBe(false)
    expect(out.events.some((e) => e.type === 'interject')).toBe(false)
  })

  it('运行结束后同一个 requestId 不再收插队（收件箱已随运行清掉）', async () => {
    const out = await runOne({ content: '任务开始' })
    expect(agentEngine.interject(out.requestId, 'ref-after', '事后一句')).toBe(false)
  })

  it('陌生 requestId 直接拒（渲染层据此把消息退回队列）', () => {
    expect(agentEngine.interject('req-not-here', 'ref-x', '话')).toBe(false)
  })

  it('子 run 不收件箱：委派出去的那一趟不许被用户插话打断', async () => {
    await runOne({
      content: '子任务',
      asChild: true,
      interject: [{ atStep: 1, clientRef: 'ref-child', text: '插进子run' }]
    })
    expect(interjectResults, '子 run 竟然收了插队').toEqual([{ clientRef: 'ref-child', accepted: false }])
  })
})

