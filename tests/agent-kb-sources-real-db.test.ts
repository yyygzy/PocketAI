// Agent 的引用来源必须带 kbId/seq —— 真库 + 真引擎 + 真端点，只把检索打桩（V4-Iter-123 A2）
//
// 为什么要真引擎而不是只测那个映射函数：
// 缺陷恰恰不在映射本身，而在「Agent 那条路自己内联写了一份 map，漏了 kbId/seq」。
// 渲染层的跳转条件是 `s.kbId && s.seq !== undefined`（MessageBubble.tsx:358），
// 少任一个就压根不出现「跳转到原文」——所以只有把落库后的 message.sources 钉住才算守住了这件事。
// 两条路分别钉：① 首轮 {{knowledge}} 自动注入；② kb_search 工具命中后经 mergeSources 并入（SEC-29）。
//
// 检索用桩（真库要 embedding provider，代价与本轮命题无关），其余全真：
// SQLite 真开、消息真落库、引擎真跑 ReAct 循环、端点是本地 127.0.0.1 的真 SSE 服务。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-sources-e2e'
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

/** 检索桩：每次 retrieve 依序吐出队列里的一批 chunk（首轮注入一次、每次 kb_search 一次） */
const R = vi.hoisted(() => ({ queue: [] as unknown[][], calls: [] as string[][] }))

vi.mock('../src/main/knowledge/rag', () => ({
  ragService: {
    retrieve: async (kbIds: string[]) => {
      R.calls.push(kbIds)
      return { query: 'q', chunks: R.queue.shift() ?? [] }
    },
    buildContext: (chunks: unknown[]) => (chunks.length > 0 ? `[知识上下文 ${chunks.length} 段]` : '')
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import { IPC, type AgentDoneEvent, type MessageSource } from '../src/shared/types'

const MODEL = 'fake-kb-model'

let bodies: Record<string, unknown>[] = []
let server: http.Server
let baseUrl = ''

/** 端点模式：'answer' 直接给终答；'callKbSearch' 先要一次 kb_search 再答 */
let endpointMode: 'answer' | 'callKbSearch' = 'answer'

function sseText(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 原生 function calling：要求模型调一次 kb_search（分两段 delta 发，与真实端点一致） */
function sseKbSearchCall(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const part = (d: unknown) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: d }] }) + '\n\n'
  res.write(part({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'kb_search', arguments: '' } }] }))
  res.write(part({ tool_calls: [{ index: 0, function: { arguments: '{"query":"退款政策"}' } }] }))
  res.write(part({ finish_reason: 'tool_calls' }))
  res.write('data: [DONE]\n\n')
  res.end()
}

function chunk(id: string, kbId: string, seq: number): unknown {
  return {
    chunkId: id,
    docId: `doc-${id}`,
    kbId,
    seq,
    docTitle: `手册 ${id}`,
    content: `片段 ${id} 正文`,
    score: 0.5
  }
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
      const msgs = (body.messages ?? []) as { role: string; content: unknown }[]
      const last = msgs[msgs.length - 1]
      const lastText = typeof last?.content === 'string' ? (last.content as string) : JSON.stringify(last?.content ?? '')
      // 工具结果回来后一律给终答（原生模式结果消息 role 是 'tool'）
      if (last?.role === 'tool' || lastText.includes('[工具结果]')) {
        sseText(res, '根据资料，7 天内可退款。')
        return
      }
      if (endpointMode === 'callKbSearch') {
        sseKbSearchCall(res)
        return
      }
      sseText(res, '根据资料，7 天内可退款。')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  const prov = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '引用来源探针',
    baseUrl,
    apiKeys: [],
    models: [MODEL],
    enabled: true,
    createdAt: Date.now()
  })
  providerRepo.updateModels(prov.id, [MODEL])
  // 模板含 {{knowledge}} 才会触发首轮检索；'*' 放行内置工具（kb_search 是内置）
  const asst = assistantRepo.save({
    name: 'kb 引用助手',
    toolPermissions: ['*'],
    systemPrompt: '你是助手。参考资料：{{knowledge}}',
    knowledgeBaseIds: ['kb-alpha', 'kb-beta'],
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

async function run(content: string): Promise<AgentDoneEvent | null> {
  bodies = []
  conversationId = conversationRepo.create({ assistantId, title: 'kb 引用', titleDefault: false }).id
  let done: AgentDoneEvent | null = null
  const emit = (channel: string, data: unknown) => {
    if (channel === IPC.AGENT_DONE_EVENT) done = data as AgentDoneEvent
    if (channel === IPC.AGENT_ERROR_EVENT) throw new Error(`Agent 运行报错: ${JSON.stringify(data)}`)
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
  return done
}

/** 会话里最后一条 assistant 消息（终答）的引用来源 */
function finalSources(): MessageSource[] {
  const msgs = messageRepo.listByConversation(conversationId)
  const last = msgs.filter((m) => m.role === 'assistant').slice(-1)[0]
  return last?.sources ?? []
}

beforeEach(() => {
  R.queue = []
  R.calls = []
  endpointMode = 'answer'
})

describe('A2：Agent 引用来源带 kbId/seq（跳转原文的前提）', () => {
  it('首轮 {{knowledge}} 注入的命中：落库的 sources 每条都有 kbId 与 seq', async () => {
    R.queue = [[chunk('c1', 'kb-alpha', 0), chunk('c2', 'kb-beta', 7)]]
    const done = await run('退款政策是什么')
    expect(done).not.toBeNull()

    const stored = finalSources()
    expect(stored.map((s) => s.chunkId)).toEqual(['c1', 'c2'])
    // 逐字段钉住：曾经这里只有 chunkId/docId/docTitle/content 四个字段
    expect(stored[0]).toEqual({
      chunkId: 'c1',
      docId: 'doc-c1',
      docTitle: '手册 c1',
      content: '片段 c1 正文',
      kbId: 'kb-alpha',
      seq: 0
    })
    expect(stored[1]?.kbId).toBe('kb-beta')
    expect(stored[1]?.seq).toBe(7)
    // DONE 事件（渲染层拿到的那份）同样带上，别只修落库不修上报
    expect(done!.sources?.map((s) => [s.kbId, s.seq])).toEqual([
      ['kb-alpha', 0],
      ['kb-beta', 7]
    ])
    // 检索用的是助手绑定的库
    expect(R.calls).toEqual([['kb-alpha', 'kb-beta']])
  })

  it('seq=0 不许被当成「没有 seq」丢掉（跳转条件是字段存在，不是真值）', async () => {
    R.queue = [[chunk('c0', 'kb-alpha', 0)]]
    await run('退款政策是什么')
    const stored = finalSources()
    expect(stored[0]?.seq).toBe(0)
    expect(stored[0]?.kbId).toBe('kb-alpha')
  })

  it('kb_search 工具命中的片段：并入 sources 后同样带 kbId/seq（SEC-29 的跳转半边）', async () => {
    endpointMode = 'callKbSearch'
    // 队列第 1 批 = 首轮注入，第 2 批 = 模型主动 kb_search 命中的另一片段
    R.queue = [[chunk('c1', 'kb-alpha', 3)], [chunk('c9', 'kb-beta', 12)]]
    const done = await run('再查一下退款政策')
    expect(done).not.toBeNull()
    expect(done!.usedTools).toBe(true)

    const stored = finalSources()
    expect(stored.map((s) => s.chunkId)).toEqual(['c1', 'c9'])
    const hit = stored.find((s) => s.chunkId === 'c9')
    expect(hit?.kbId).toBe('kb-beta')
    expect(hit?.seq).toBe(12)
    // kb_search 的正文是给模型看的截断摘要，来源里记的应是它实际返回的内容（不是原文全量）
    expect(hit?.content).toContain('片段 c9 正文')
  })
})
