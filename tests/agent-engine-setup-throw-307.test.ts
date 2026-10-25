// @vitest-environment node
// setup 段抛出的兜底收尾测试（V4-Iter-307）
//
// 缺陷：AgentEngine.run() 从循环**之前**就登记资源——traceParents/traceModels 在第一行、
// master/controllers/interjections/loopTimer 在约 1142-1146，而清理它们的 finally 挂在**循环体**那层
// try（约 1301→1401）。于是 setup 段（解析助手、messageRepo.insert、conversationRepo.touch、getAdapter、
// 建 ctx……）一旦抛出，那层 finally 从没进入 ⇒ ① 五样登记留在原地泄漏（requestId 唯一 ⇒ 无界累加）；
// ② 会话卡 streaming、不发 AGENT_ERROR_EVENT、渲染端那张卡永远"思考中…"（发错误事件的内层 catch 也没跑）。
//
// 修法：把 setup+循环整段包进**外层 try**，catch 补上与内层同款收尾（清登记 + 发错误事件 + 落会话状态）；
// loopTimer 提到 try 外（setup 早抛时它还是 undefined，catch 用 if 兜）。
//
// 复现：真起 DB + 真 provider/助手/会话，只把 messageRepo.insert 桩成抛错（它在所有关键登记之后、任何
// LLM 调用之前），无需假 HTTP 服务。判据取公开可观测的下游后果：修后 run() 正常 resolve 且发
// AGENT_ERROR_EVENT、会话 status=error、engine.controllers 不再含该 requestId；修前 run() 会把异常抛给调用方。
// 反向对照：空 targets 在第一行守卫里抛（那时还什么都没登记）⇒ 依旧向外 reject（证明没把 try 提到守卫之前）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-307-engine-setup'
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
import { IPC, type AgentErrorEvent, type SendMessagePayload } from '../src/shared/types'

let providerId = ''
let assistantId = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: 'p307',
    baseUrl: 'http://127.0.0.1:1/v1', // 不会被调到（insert 先抛），仅让 providerId 合法
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({ name: 'a307', toolPermissions: ['*'] }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

function makePayload(): { payload: SendMessagePayload; requestId: string; convId: string } {
  const requestId = 'rq307-' + Math.random().toString(36).slice(2)
  const conv = conversationRepo.create({ assistantId, title: 't', titleDefault: false })
  const payload = {
    requestId,
    conversationId: conv.id,
    content: '说一句好',
    assistantId,
    targets: [{ providerId, model: 'm1' }],
    agentMode: true
  } as unknown as SendMessagePayload
  return { payload, requestId, convId: conv.id }
}

describe('§307 setup 段抛出：补内层同款收尾（发错误事件 + 清登记），不把异常抛给调用方留泄漏', () => {
  it('messageRepo.insert 抛 ⇒ run() 正常 resolve、发 AGENT_ERROR_EVENT、会话 status=error、engine.controllers 已摘该 requestId', async () => {
    const { payload, requestId, convId } = makePayload()
    const errs: AgentErrorEvent[] = []
    const emit = (channel: string, data: unknown): void => {
      if (channel === IPC.AGENT_ERROR_EVENT) errs.push(data as AgentErrorEvent)
    }
    const spy = vi.spyOn(messageRepo, 'insert').mockImplementation(() => {
      throw new Error('DISK_NO_SPACE: 写库失败')
    })
    try {
      // 修前：这里 reject（异常冒到调用方）；修后：run() resolve，错误经事件上报
      await expect(agentEngine.run(payload, emit)).resolves.toBeUndefined()
      expect(errs, 'setup 抛出必须发一颗 AGENT_ERROR_EVENT（否则渲染端永远"思考中"）').toHaveLength(1)
      expect(String(errs[0]?.error)).toContain('写库失败')
      expect(conversationRepo.get(convId)?.status).toBe('error')
      expect((agentEngine as unknown as { controllers: Map<string, unknown> }).controllers.has(requestId)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('反向对照：空 targets 在第一行守卫里抛（那时还什么都没登记）⇒ 依旧向外 reject，外层 try 没把它吞掉', async () => {
    const { payload } = makePayload()
    const bad = { ...payload, targets: [] } as unknown as SendMessagePayload
    await expect(agentEngine.run(bad, () => {})).rejects.toThrow(/CHAT_NO_TARGET|未选择模型/)
  })
})
