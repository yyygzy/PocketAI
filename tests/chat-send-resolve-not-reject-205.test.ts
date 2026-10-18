// chat 发起类通道的"两条面"分工（V4-Iter-205）：
//   同步段的失败 ⇒ 抛错 ⇒ safeHandle 转成 `{ok:false}` **返回值**（204 起四个入口都读它）；
//   流式期的失败／用户中止 ⇒ 走 CHAT_DONE／CHAT_ERROR **事件面**，`send()` 本身照常 resolve。
// 为什么必须把这条钉住：204 让渲染层开始对返回值报错误，如果"点停止生成"也从返回值面冒出
// 一条 `{ok:false}`，用户就会在正常中止后看到一条错误 toast。改前的形状靠的是
// `chat-service.ts:315` 的 `Promise.allSettled`（不是 Promise.all）。
// 真机这一格我没跑到（探针两次都停在"没有可发送目标"，见台账 §205），所以用真 HTTP 端点 + 真库
// 在 CI 里把两条面钉死——同 `agent-text-protocol-real-endpoint.test.ts` 的路子，不 mock fetch/adapter。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-chat-send-contract'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})
const keeps = vi.hoisted(() => ({ acquire: 0, release: 0 }))

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
// powerSaveBlocker 在 node 环境里不存在；这里只关心"引用计数平不平"
vi.mock('../src/main/keep-awake', () => ({
  acquireKeepAwake: () => { keeps.acquire++ },
  releaseKeepAwake: () => { keeps.release++ }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { chatService } from '../src/main/chat/chat-service'
import { IPC, type ChatErrorEvent, type SendMessagePayload } from '../src/shared/types'

const FAIL_MODEL = 'endpoint-500'
const SLOW_MODEL = 'slow-sse'

let server: http.Server
let baseUrl = ''
let providerId = ''
let conversationId = ''
/** 端点是否还在往连接里写 delta（中止判据） */
let streaming = false

function payload(model: string, requestId: string): SendMessagePayload {
  return {
    requestId,
    conversationId,
    assistantId: null,
    content: '契约验证',
    targets: [{ providerId, model }]
  } as SendMessagePayload
}

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  server = http.createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { model?: string }
      if (body.model === FAIL_MODEL) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }))
        return
      }
      // 慢速 SSE：每 80ms 一段，直到客户端断开或写满 40 段
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      streaming = true
      let alive = true
      req.on('close', () => { alive = false })
      for (let i = 0; i < 40 && alive; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `字${i} ` } }] })}\n\n`)
        await new Promise((r) => setTimeout(r, 80))
      }
      if (alive) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
      streaming = false
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`

  const prov = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '两条面探针',
    baseUrl,
    apiKeys: [],
    models: [FAIL_MODEL, SLOW_MODEL],
    enabled: true,
    createdAt: Date.now()
  })
  providerId = prov.id
  conversationId = conversationRepo.create({}).id
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

describe('流式期的失败不进返回值面', () => {
  it('端点回 500：send() 照常 resolve，失败只从 CHAT_ERROR_EVENT 出来一次', async () => {
    const evts: Array<{ ch: string; data: unknown }> = []
    await expect(chatService.send(payload(FAIL_MODEL, 'req-500'), (ch, data) => evts.push({ ch, data }))).resolves.toBeUndefined()
    const errs = evts.filter((e) => e.ch === IPC.CHAT_ERROR_EVENT).map((e) => e.data as ChatErrorEvent)
    expect(errs.length).toBe(1)
    expect(errs[0]!.requestId).toBe('req-500')
    expect(errs[0]!.error).toContain('500')
  })

  it('生成中点「停止生成」：send() 不 reject，中止不进错误 toast 那条面', async () => {
    const evts: Array<{ ch: string; data: unknown }> = []
    const p = chatService.send(payload(SLOW_MODEL, 'req-abort'), (ch, data) => evts.push({ ch, data }))
    // 等第一段 delta 真回到服务里，才谈得上"中途叫停"
    for (let i = 0; i < 60 && !streaming; i++) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 200))
    chatService.abort('req-abort')
    await expect(p).resolves.toBeUndefined()
    // 中止的出口是事件面（done 带部分正文 或 error），不是 promise 失败
    expect(evts.some((e) => e.ch === IPC.CHAT_DONE_EVENT || e.ch === IPC.CHAT_ERROR_EVENT)).toBe(true)
    expect(streaming).toBe(false)
  })

  it('保活引用计数配平（两条面都收尾在同一个 finally）', async () => {
    expect(keeps.release).toBe(keeps.acquire)
  })
})

describe('反向对照：同步段的失败确实从返回值面走', () => {
  it('targets 为空 ⇒ send() reject（safeHandle 会把它转成 {ok:false}）', async () => {
    const evts: Array<{ ch: string }> = []
    const p = chatService.send({ ...payload(SLOW_MODEL, 'req-empty'), targets: [] }, (ch) => evts.push({ ch }))
    await expect(p).rejects.toThrow(/未选择模型/)
    // 一个事件都没发：它根本没进入流式期
    expect(evts.length).toBe(0)
  })
})

describe('regenerate／resend 是同一条契约的另外两个落点', () => {
  // `Promise.allSettled` 在 chat-service 里出现三次（315／390／465）。只钉第一处的那条
  // 用例管不到另外两条链——而 204 之后这三条链的返回值都会弹到用户脸上。
  it('端点 500：regenerate 也 resolve，失败只走事件面', async () => {
    const assistantMsg = messageRepo
      .listByConversation(conversationId)
      .find((m) => m.role === 'assistant')
    expect(assistantMsg, '前面的用例应已落进一条助手消息').toBeTruthy()
    const evts: Array<{ ch: string }> = []
    await expect(
      chatService.regenerate(
        {
          requestId: 'req-regen-500',
          conversationId,
          assistantId: null,
          messageId: assistantMsg!.id,
          targets: [{ providerId, model: FAIL_MODEL }]
        } as Parameters<typeof chatService.regenerate>[0],
        (ch) => evts.push({ ch })
      )
    ).resolves.toBeUndefined()
    expect(evts.some((e) => e.ch === IPC.CHAT_ERROR_EVENT)).toBe(true)
  })

  it('端点 500：resend 也 resolve，失败只走事件面', async () => {
    const userMsg = messageRepo.listByConversation(conversationId).find((m) => m.role === 'user')
    expect(userMsg, '前面的用例应已落进一条用户消息').toBeTruthy()
    const evts: Array<{ ch: string }> = []
    await expect(
      chatService.resend(
        {
          requestId: 'req-resend-500',
          conversationId,
          assistantId: null,
          messageId: userMsg!.id,
          targets: [{ providerId, model: FAIL_MODEL }]
        } as Parameters<typeof chatService.resend>[0],
        (ch) => evts.push({ ch })
      )
    ).resolves.toBeUndefined()
    expect(evts.some((e) => e.ch === IPC.CHAT_ERROR_EVENT)).toBe(true)
  })
})
