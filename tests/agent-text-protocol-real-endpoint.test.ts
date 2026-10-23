// B55 的真机替代验证：**真 HTTP 端点 + 真引擎循环**，不 mock fetch/adapter
//
// 为什么要这条：文本协议开关的两条单测都只看"纯函数对不对"（ensureProtocolPrompt 注入、
// extractTextToolCalls 解析），于是"徽标点下去之后**发给端点的请求真的变了**、
// 端点回一段 ```tool_call 围栏**真的会执行工具**"这条整链在 CI 里是断的——
// 而这正是 B55 ②③ 要证的三件事（开了生效、关了退回、作用域是一台模型一个）。
// 这里起一个真的 OpenAI 兼容 SSE 端点（本地 127.0.0.1），provider/assistant/conversation
// 都落进真库，然后调 agentEngine.run 走完整 ReAct 循环。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-text-protocol-e2e'
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
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import { setTextProtocolModel } from '../src/main/agent/text-protocol-prefs'
import { IPC, type AgentDoneEvent } from '../src/shared/types'

const MODEL = 'fake-no-toolcall'
const PROTOCOL_MARKER = '## 工具调用协议'

/** 端点收到的请求体（每个 scenario 前清空），用于断言"发出去的东西真的变了" */
let bodies: Record<string, unknown>[] = []
let server: http.Server
let baseUrl = ''

function sseText(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * 模拟一台"不会返回原生工具调用"的小模型：
 * - 收到 system 里有协议段 ⇒ 按约定回 ```tool_call 围栏（这正是 B55 里小模型被教会的行为）
 * - 上一轮是 tool 结果 ⇒ 把工具内容转述成回答
 * - 其余（原生路径，没有任何工具结果可转述）⇒ 只报一个自创时间，不调工具
 */
function replyFor(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as { role: string; content: unknown }[]
  const last = msgs[msgs.length - 1]
  const lastText = typeof last?.content === 'string' ? (last.content as string) : JSON.stringify(last?.content ?? '')
  // 认工具结果有两条路：原生模式是 role:'tool'，文本协议模式是 user 消息里的 [工具结果] 前缀
  if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
    return `查到了：${lastText.slice(0, 120)}`
  }
  const sys = typeof msgs[0]?.content === 'string' ? (msgs[0].content as string) : ''
  if (sys.includes(PROTOCOL_MARKER) && body.tools === undefined) {
    return '我先查一下。\n```tool_call\n{"name":"time_now","arguments":{}}\n```'
  }
  return '现在是 2023年10月5日 12:00（模型自己编的，没有调用任何工具）'
}

/** 端点行为可切换：'native' 会回真正的 delta.tool_calls；'fence' 只会写文本围栏 */
let endpointMode: 'native' | 'fence' = 'fence'
/** 置 true 后，凡是带 tools 字段的请求一律 400（模拟 Ollama/LM Studio 这类不支持 tools 的端点） */
let rejectTools = false

/** 原生 function calling 的 SSE：把一次 time_now 调用拆成两段 delta 发（真实端点就是这么发的） */
function sseNativeToolCall(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(part({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'time_now', arguments: '' } }] }))
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function sseUnsupported(res: http.ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'this model does not support tools' } }))
}
let assistantId = ''
let conversationId = ''

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
      if (rejectTools && body.tools !== undefined) {
        sseUnsupported(res)
        return
      }
      if (endpointMode === 'native' && body.tools !== undefined) {
        sseNativeToolCall(res)
        return
      }
      sseText(res, replyFor(body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  const prov = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '端点探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  })
  providerRepo.updateModels(prov.id, [MODEL])
  const asst = assistantRepo.save({
    name: 'e2e 助手',
    toolPermissions: ['*'],
    systemPrompt: '',
    knowledgeBaseIds: [],
    skillIds: []
  })
  assistantId = asst.id
  ;(globalThis as { __providerId?: string }).__providerId = prov.id
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

const providerId = () => (globalThis as { __providerId?: string }).__providerId!

async function run(content: string, reuseConversation = false): Promise<{ done: AgentDoneEvent | null; error: string }> {
  bodies = []
  // 默认每次一个新会话：SEC-13 的工具指纹白名单是**按会话**记的，
  // 同一会话里重复问同一句会让第二次的时间调用被判为"本会话已执行过"而跳过。
  // 想验"跨轮历史"时显式传 reuseConversation=true。
  if (!reuseConversation) {
    conversationId = conversationRepo.create({ assistantId, title: 'e2e', titleDefault: false }).id
  }
  let done: AgentDoneEvent | null = null
  let error = ''
  const emit = (channel: string, data: unknown) => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    if (channel === IPC.AGENT_ERROR_EVENT) error = JSON.stringify(data)
  }
  await agentEngine.run(
    {
      requestId: `req-${Date.now()}`,
      conversationId,
      assistantId,
      content,
      agentMode: true,
      targets: [{ providerId: providerId(), model: MODEL }]
    },
    emit
  )
  return { done, error }
}

describe('B55：模型级文本协议开关在真端点上的整链行为', () => {
  it('未点名：请求照旧带 tools 字段、system 里没有协议段，模型不调工具 ⇒ usedTools=false', async () => {
    const { done, error } = await run('现在几点了')
    expect(error).toBe('')
    const first = bodies[0] as Record<string, unknown>
    expect(Array.isArray(first.tools)).toBe(true)
    expect((first.tools as unknown[]).length).toBeGreaterThan(0)
    const sys = ((first.messages as { content: string }[])[0]?.content ?? '') as string
    expect(sys).not.toContain(PROTOCOL_MARKER)
    expect(done).not.toBeNull()
    expect(done!.usedTools).toBe(false)
    expect(done!.fullContent).toContain('2023年10月5日') // 瞎报的时间——这就是 B55 要修的现场
  })

  it('点名后：首轮不传 tools、协议段进 system，围栏被解析并**真的执行** time_now ⇒ usedTools=true', async () => {
    setTextProtocolModel(providerId(), MODEL, true)
    const { done, error } = await run('现在几点了')
    expect(error).toBe('')
    const first = bodies[0] as Record<string, unknown>
    expect(first.tools).toBeUndefined()
    const sys = ((first.messages as { content: string }[])[0]?.content ?? '') as string
    expect(sys).toContain(PROTOCOL_MARKER)
    // 第二轮：文本协议模式下工具结果是以 user 消息回填的（role:'tool' 要 tool_call_id，
    // 对不支持 tools 的端点反而会报错）
    expect(bodies.length).toBeGreaterThan(1)
    const second = bodies[1] as Record<string, unknown>
    const secondText = JSON.stringify(second.messages)
    expect(secondText).toContain('[工具结果] time_now')
    expect(done!.usedTools).toBe(true)
    expect(done!.fullContent).toContain('查到了：')
    // 工具结果不是模型编的：落到 DB 里的最终回答应带真实年份
    const last = messageRepo.listByConversation(conversationId).slice(-1)[0]!
    expect(last.role).toBe('assistant')
    expect(last.content).toMatch(/20\d\d/)
  })

  it('关掉开关 ⇒ 退回原生路径（证明它是真开关，不是单向阀）', async () => {
    setTextProtocolModel(providerId(), MODEL, false)
    const { done } = await run('现在几点了')
    const first = bodies[0] as Record<string, unknown>
    expect(Array.isArray(first.tools)).toBe(true)
    expect(((first.messages as { content: string }[])[0]?.content ?? '')).not.toContain(PROTOCOL_MARKER)
    expect(done!.usedTools).toBe(false)
  })

  it('跨轮：第二轮的请求里不许出现 tool_calls（那是端点报 400 的字段）', async () => {
    setTextProtocolModel(providerId(), MODEL, true)
    // 同一个会话连跑两轮：第一轮的 assistant.tool_calls 已落库，buildContext 会把它还原回来
    await run('现在几点了')
    bodies = []
    const { done, error } = await run('那 100 天后是几号', true)
    expect(error).toBe('')
    expect(done!.usedTools).toBe(true)
    const dumped = JSON.stringify(bodies)
    expect(dumped).not.toContain('"tool_calls"')
    expect(dumped).toContain('[工具结果]')
    setTextProtocolModel(providerId(), MODEL, false)
  })

  it('端点报「不支持 tools」⇒ 自动降级那条路也真的执行工具，并把历史里的 tool_calls 抹掉', async () => {
    setTextProtocolModel(providerId(), MODEL, false)
    endpointMode = 'native'
    // 第一轮：原生 function calling 正常干活，assistant.tool_calls 落库（下一轮 buildContext 会还原回来）
    const native = await run('现在几点了')
    expect(native.done).not.toBeNull()
    expect(native.done!.usedTools).toBe(true)

    // 第二轮：同一会话，端点换成「见到 tools 就 400」（真小模型的常见现场）
    endpointMode = 'fence'
    rejectTools = true
    const degraded = await run('那 100 天后是几号', true)
    expect(degraded.error).toBe('')
    expect(degraded.done).not.toBeNull()
    expect(degraded.done!.usedTools).toBe(true)
    // 按内容找「切换之后」的请求（按下标不稳定：同文件里前后用例共享端点状态）
    const afterSwitch = (bodies as Record<string, unknown>[]).filter((b) =>
      JSON.stringify(b).includes(PROTOCOL_MARKER)
    )
    expect(afterSwitch.length).toBeGreaterThan(0)
    for (const b of afterSwitch) expect(b.tools).toBeUndefined()
    // 「切换后上下文里不许再有 assistant.tool_calls」⇒ 本文件下一条 it 钉住（手动塞历史＋触发降级）；
    // helper 自身的确定性用例在 tests/agent-context.test.ts。
    rejectTools = false
  })

  it('作用域是一台模型一个：点名另一台不影响这台', async () => {
    setTextProtocolModel(providerId(), MODEL, true)
    setTextProtocolModel(providerId(), 'another-model', true)
    const { done } = await run('现在几点了')
    expect(((bodies[0] as Record<string, unknown>).tools)).toBeUndefined()
    expect(done!.usedTools).toBe(true)
    setTextProtocolModel(providerId(), MODEL, false)
    setTextProtocolModel(providerId(), 'another-model', false)
  })

  it('降级路径里 stripToolCallsFromContext 真被调用：历史有 tool_calls 时，切换后的请求里 messages 不含 tool_calls', async () => {
    // 这条钉住 engine.ts:1571 的调用点——helper 自己的单测在 agent-context.test.ts，
    // 但"降级路径真调了它"这条只有 e2e 能证。顺序耦合的解法：手动往库里塞历史，不依赖前一条用例。
    const freshConvId = conversationRepo.create({ assistantId, title: 'strip-probe', titleDefault: false }).id
    // 塞一条带 tool_calls 的 assistant 消息＋一条 tool 结果（正是 buildContext 会还原回来的形状）
    messageRepo.insert({
      conversationId: freshConvId,
      role: 'user',
      content: '现在几点'
    })
    messageRepo.insert({
      conversationId: freshConvId,
      role: 'assistant',
      content: '我查一下',
      toolCalls: JSON.stringify([{ id: 'tc_probe', type: 'function', function: { name: 'time_now', arguments: '{}' } }])
    })
    messageRepo.insert({
      conversationId: freshConvId,
      role: 'tool',
      content: '{"toolCallId":"tc_probe","content":"18:00"}'
    })
    // 触发降级：端点见到 tools 就 400
    endpointMode = 'fence'
    rejectTools = true
    let done: AgentDoneEvent | null = null
    let error = ''
    const emit = (channel: string, data: unknown) => {
      if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
      if (channel === IPC.AGENT_ERROR_EVENT) error = JSON.stringify(data)
    }
    bodies = []
    await agentEngine.run(
      {
        requestId: `req-strip-${Date.now()}`,
        conversationId: freshConvId,
        assistantId,
        content: '那 100 天后是几号',
        agentMode: true,
        targets: [{ providerId: providerId(), model: MODEL }]
      },
      emit
    )
    expect(error).toBe('')
    expect(done).not.toBeNull()
    // 关键断言：降级后的那次请求（带 PROTOCOL_MARKER 的那次）里，assistant 消息不含 tool_calls 字段
    // （tool 消息的 tool_call_id 是另一回事，stripToolCallsFromContext 不管它）
    const afterSwitch = bodies.filter((b) => JSON.stringify(b).includes(PROTOCOL_MARKER))
    expect(afterSwitch.length).toBeGreaterThan(0)
    for (const b of afterSwitch) {
      const msgs = (b.messages as { role: string; tool_calls?: unknown }[]) ?? []
      const assistantMsgs = msgs.filter((m) => m.role === 'assistant')
      // 如果 stripToolCallsFromContext 没被调用，assistant 消息里会出现 tool_calls 字段
      for (const a of assistantMsgs) {
        expect(a.tool_calls).toBeUndefined()
      }
    }
    rejectTools = false
  })
})
