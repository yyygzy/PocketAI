// @vitest-environment node
// V4-Iter-234 的接线证据：**引擎那一轮真的按声明的窗口去裁历史**。
//
// 为什么不能只有纯函数那一份（agent-context-window-plan-234）：纯函数测过 ≠ 接上过。
// §232 那次是 N4／N6／N7 三条变异打了等于没打，补的正是"接线断言"；这一条同一条轴。
// 形状复用 `agent-tool-offload-chain-232`：真 SQLite + 真引擎 + 真本地 SSE 端点，
// 判据取的是**发给端点的那一份载荷**（带 system 的那一发才是主推理步；摘要与标题那两发没有 system）。
//
// 三档各证一件事：
//  · 未声明 ⇒ 与改动前逐条相同（最近 30 条 + 早期进摘要）；
//  · 声明 200k ⇒ 带得动 40 轮（"放开"那一半，旧口径在这里只会带 30 条）；
//  · 声明一个装不下的数 ⇒ 只带最新一问，其余全进摘要（收紧那一半，且没把用户的问题裁掉）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-234-chain'
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
import { setModelContextWindow } from '../src/main/agent/model-window-prefs'
import { DEFAULT_MESSAGES_WHEN_WINDOW_UNSET } from '../src/shared/model-window'
import { IPC, type AgentDoneEvent } from '../src/shared/types'

const MODEL = 'fake-window'
/** 种多少轮老对话：40 轮 ⇒ 80 条，超过 30 条那道旧窗口，也够看出"放开" */
const OLD_TURNS = 40

let server: http.Server
let providerId = ''
/** 每一次发给端点的请求体 */
let bodies: Record<string, unknown>[] = []

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 主推理步那一发：只有它带 system 消息 */
function mainBody(): { role: string; content: unknown }[] {
  const found = bodies.find((b) => {
    const msgs = (b.messages ?? []) as { role: string }[]
    return msgs.some((m) => m.role === 'system')
  })
  expect(found, '端点没收到主推理步那一发').toBeTruthy()
  return (found!.messages ?? []) as { role: string; content: unknown }[]
}

function flatText(msgs: { role: string; content: unknown }[]): string {
  return msgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n')
}

/** 摘要那一发有没有发生（发生了 ⇒ 被切掉的早期消息确实进了摘要，SEC-19 那条对齐规矩） */
function summarySent(): boolean {
  return bodies.some((b) => {
    const msgs = (b.messages ?? []) as { role: string; content: unknown }[]
    return !msgs.some((m) => m.role === 'system') && flatText(msgs).includes('总结以下对话历史')
  })
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
      bodies.push(body)
      const msgs = (body.messages ?? []) as { role: string }[]
      // 摘要/标题那一发回一句短话；主推理步直接给最终回答（这一批不需要工具）
      const isMain = msgs.some((m) => m.role === 'system')
      sse(res, isMain ? '收尾回答' : '摘要：无要点')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '窗口探针',
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

/** 新建一个会话，种 OLD_TURNS 轮老对话，然后跑一轮；返回发给端点的载荷与历史条数 */
async function runWithWindow(tokens: number | null): Promise<{
  messages: { role: string; content: unknown }[]
  done: AgentDoneEvent | null
}> {
  // tokens=null 是"清除"（不是"设成未设过的默认"）——④ 那条取消声明走的正是这一支
  setModelContextWindow(providerId, MODEL, tokens)
  const asst = assistantRepo.save({ name: `助手-${Date.now()}`, toolPermissions: [] })
  const convId = conversationRepo.create({ assistantId: asst.id, title: '窗口', titleDefault: false }).id
  for (let i = 1; i <= OLD_TURNS; i++) {
    const mark = String(i).padStart(2, '0')
    messageRepo.insert({ conversationId: convId, role: 'user', content: `老问${mark}：` + '问'.repeat(30) })
    messageRepo.insert({ conversationId: convId, role: 'assistant', content: `老答${mark}：` + '答'.repeat(30) })
  }
  bodies = []
  let done: AgentDoneEvent | null = null
  const emit = (channel: string, data: unknown): void => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
  }
  await agentEngine.run(
    {
      requestId: `req-234-${Date.now()}`,
      conversationId: convId,
      assistantId: asst.id,
      content: '最新一问',
      agentMode: true,
      targets: [{ providerId, model: MODEL }]
    },
    emit
  )
  expect(done, '这一轮没跑完').not.toBeNull()
  return { messages: mainBody(), done }
}

describe('① 未声明窗口：与改动前逐条相同', () => {
  it('主请求带最近 30 条记录（发出来的是 29 条消息）+ system，且早期那一截走了摘要', async () => {
    const { messages } = await runWithWindow(null)
    const history = messages.filter((m) => m.role !== 'system')
    // 为什么是 29 不是 30：81 条记录（80 条种的就偶数 + 这一问）按"最后 30 条"切片，
    // 起点正落在一条 assistant 上，而 buildContext 那条既有守卫会剥掉"前面没有用户消息的 assistant"。
    // 这是改动前就有的行为（不是本批引入的），写死在这里是为了让它别被悄悄改掉。
    expect(history).toHaveLength(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET - 1)
    const text = flatText(messages)
    expect(text).toContain('最新一问')
    expect(text).toContain('老问40')
    expect(text).toContain('老问27')
    // 被剥掉的那一条：起点上的助手消息（同一切片里它前面没有用户消息）
    expect(text).not.toContain('老答26')
    expect(text).not.toContain('老问01')
    expect(summarySent(), '被窗口切掉的早期消息没进摘要（SEC-19 那条对齐规矩）').toBe(true)
  })
})

describe('② 声明 200k：带得动比 30 条更多的历史（放开那一半）', () => {
  it('81 条记录全带上，最老那一问也在，且不再需要摘要', async () => {
    const { messages } = await runWithWindow(200_000)
    const history = messages.filter((m) => m.role !== 'system')
    // 80 条老对话 + 这一轮的「最新一问」（引擎会先落用户消息再取历史）
    expect(history.length).toBeGreaterThan(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET)
    expect(history).toHaveLength(OLD_TURNS * 2 + 1)
    const text = flatText(messages)
    expect(text).toContain('老问01')
    expect(text).toContain('最新一问')
    expect(summarySent(), '一条都没被切掉，不该再发摘要那一发').toBe(false)
  })
})

describe('③ 声明一个装不下的数：只带最新一问，其余进摘要', () => {
  it('主请求只有 system + 这一问；固定开销超了窗口也不把用户的问题裁掉', async () => {
    const { messages } = await runWithWindow(512)
    const history = messages.filter((m) => m.role !== 'system')
    expect(history).toHaveLength(1)
    const text = flatText(messages)
    expect(text).toContain('最新一问')
    expect(text).not.toContain('老问40')
    expect(summarySent(), '被切掉的 80 条必须进摘要').toBe(true)
  })
})

describe('④ 清掉声明后回到旧口径（这一档是"设了又取消"那条路）', () => {
  it('设过 200k 再清除 ⇒ 同一份历史又只带 30 条', async () => {
    await runWithWindow(200_000)
    const { messages } = await runWithWindow(null)
    expect(messages.filter((m) => m.role !== 'system')).toHaveLength(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET - 1)
  })
})
