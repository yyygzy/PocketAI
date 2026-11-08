// @vitest-environment node
// P2 / V4-Iter-459：同会话单活动 run 守卫。
//
// 假 adapter 用一扇可控的闸门把第一轮挂在 LLM 步骤上；此时直接对同一会话再起第二轮，
// 引擎必须在登记之前拒绝（AGENT_RUN_BUSY），且被拒的一轮不写用户消息。
// 第一轮释放并跑完后，同一会话可以正常再起一轮（守卫没有把会话永久锁住）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-conversation-guard'
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

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd(), getAppPath: () => process.cwd() },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  },
  ipcMain: { handle: () => {}, on: () => {} }
}))

// 闸门：第一轮进到 LLM 步骤后挂住；`release()` 之后所有调用立即返回最终答案
let releaseGate: (() => void) | null = null
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve
})
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async () => {
        await gate
        return { content: 'done', toolCalls: [] }
      }
    })
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import type { SendMessagePayload } from '../src/shared/types'

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
    name: 'p-guard',
    baseUrl: 'http://127.0.0.1:1/v1', // adapter 已桩，不会被真实调用
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  // 不给工具权限：一轮就是一次 LLM 调用，闸门放开即完成
  assistantId = assistantRepo.save({ name: 'a-guard', toolPermissions: [] }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('等待第一轮登记超时')
}

function payloadOf(requestId: string, conversationId: string, content: string): SendMessagePayload {
  return {
    requestId,
    conversationId,
    content,
    assistantId,
    targets: [{ providerId, model: 'm1' }],
    agentMode: true
  } as unknown as SendMessagePayload
}

describe('同会话单活动 run 守卫', () => {
  it('并发第二轮被明确拒绝、不写消息；第一轮结束后同会话可再起一轮', async () => {
    const requestIdA = 'rq-guard-a-' + Math.random().toString(36).slice(2)
    const conv = conversationRepo.create({ assistantId, title: 'guard', titleDefault: false })
    const emit = (): void => {}
    const runA = agentEngine.run(payloadOf(requestIdA, conv.id, '第一轮'), emit)

    // 第一轮已经进了 setup（用户消息落库）并挂在闸门上
    await waitFor(() => messageRepo.listByConversation(conv.id).length >= 1)

    const requestIdB = 'rq-guard-b-' + Math.random().toString(36).slice(2)
    await expect(agentEngine.run(payloadOf(requestIdB, conv.id, '第二轮'), emit)).rejects.toThrow(
      'AGENT_RUN_BUSY'
    )
    // 被拒的一轮没有写用户消息（守卫在第一处登记之前）
    expect(messageRepo.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(1)

    releaseGate?.()
    await runA
    expect(agentEngine.hasActiveRun()).toBe(false)

    // 锁已释放：同一会话可以正常起下一轮
    const requestIdC = 'rq-guard-c-' + Math.random().toString(36).slice(2)
    await agentEngine.run(payloadOf(requestIdC, conv.id, '第三轮'), emit)
    expect(messageRepo.listByConversation(conv.id).filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
