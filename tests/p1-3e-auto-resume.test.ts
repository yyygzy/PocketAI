// @vitest-environment node
// P1-3e：启动后自动续跑（真库 + mock provider）。
// 只续 interrupted ready；failed/blocked/过期候选一律不发一次模型；每进程只跑一次。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-auto-resume-p13e'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})
const S = vi.hoisted(() => ({ llmCalls: 0 }))
const B = vi.hoisted(() => ({ events: [] as Array<[string, unknown]> }))

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
    static getAllWindows() { return [] }
  },
  powerSaveBlocker: { start: () => 1, stop: () => {} },
  ipcMain: { handle: () => {}, on: () => {} }
}))
vi.mock('../src/main/ipc/broadcast', () => ({
  broadcast: (channel: string, data: unknown) => { B.events.push([channel, data]) }
}))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async () => {
        S.llmCalls += 1
        return { content: '自动续跑完成', toolCalls: [] }
      }
    })
  }
}))

import { dbService } from '../src/main/db/database'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { conversationRunRepo } from '../src/main/db/repositories/conversation-run.repo'
import { resetRuntimeRegistryForTest, setRuntimePersistence } from '../src/main/chat/runtime-registry'
import { AUTO_RESUME_KEY, resetAutoResumeForTest, startAutoResume } from '../src/main/chat/auto-resume'
import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import type { MessageRecord } from '../src/shared/types'

setRuntimePersistence(conversationRunRepo)

let providerId = ''
let assistantId = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  providerId = providerRepo.save({
    id: '', type: 'openai-compatible', name: 'p-auto-resume', baseUrl: 'http://127.0.0.1:1/v1',
    apiKeys: [], models: ['m1'], enabled: true, createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({ name: 'a-auto-resume', toolPermissions: ['fs.read'] }).id
})

afterAll(() => {
  try { dbService.close() } catch { /* ignore */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetRuntimeRegistryForTest()
  resetAutoResumeForTest()
  S.llmCalls = 0
  B.events.length = 0
  for (const table of ['conversation_runs', 'messages', 'conversations']) {
    dbService.getHandle().prepare(`DELETE FROM ${table}`).run()
  }
  appConfigRepo.set(AUTO_RESUME_KEY, '1')
  setWorkspaceDir(path.join(P.data, 'current'))
})

function newConversation(title: string): string {
  const conv = conversationRepo.create({ assistantId, title, titleDefault: false })
  conversationRepo.setRunState(conv.id, { modelLabel: `${providerId}:m1`, agentMode: true })
  return conv.id
}

/** 一条停在 model 步、产物齐全的可续中断：一个 done assistant 对着锚点 */
function seedReady(convId: string, requestId: string, workspaceDir?: string): void {
  const anchor = messageRepo.insert({
    conversationId: convId, role: 'user', content: '原始提问', status: 'done'
  }) as MessageRecord
  messageRepo.insert({
    conversationId: convId, role: 'assistant', content: '已答', status: 'done', parentId: anchor.id
  })
  conversationRunRepo.start({
    requestId, conversationId: convId, mode: 'agent', startedAt: Date.now() - 1000,
    anchorUserMessageId: anchor.id, workspaceDir
  })
  conversationRunRepo.checkpoint(requestId, { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
}

function seedFailed(convId: string, requestId: string): void {
  seedReady(convId, requestId)
  conversationRunRepo.finish(requestId, 'failed', 'provider 500')
}

const runCount = (): number =>
  (dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM conversation_runs').get() as { n: number }).n

describe('P1-3e 启动后自动续跑', () => {
  it('急停开关关闭 ⇒ 零模型调用、零新 run', async () => {
    const convId = newConversation('关闭开关')
    seedReady(convId, 'req-off')
    conversationRunRepo.interruptActive()
    appConfigRepo.set(AUTO_RESUME_KEY, '0')

    await startAutoResume()

    expect(S.llmCalls).toBe(0)
    expect(runCount()).toBe(1)
    expect(conversationRunRepo.getLatest(convId)?.status).toBe('interrupted')
  })

  it('可续 interrupted ⇒ 自动续一次，新 requestId、不重复插用户消息，事件走全局广播', async () => {
    const convId = newConversation('自动续跑')
    seedReady(convId, 'req-auto')
    conversationRunRepo.interruptActive()

    await startAutoResume()

    expect(S.llmCalls).toBe(1)
    expect(runCount()).toBe(2)
    const latest = conversationRunRepo.getLatest(convId)
    expect(latest?.status).toBe('done')
    expect(latest?.requestId).not.toBe('req-auto')
    expect(conversationRunRepo.getByRequest('req-auto')?.status).toBe('interrupted')
    expect(messageRepo.listByConversation(convId).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(B.events.length).toBeGreaterThan(0)
  })

  it('每进程只跑一次：第二次启动钩子是空操作', async () => {
    const convId = newConversation('只跑一次')
    seedReady(convId, 'req-once')
    conversationRunRepo.interruptActive()

    await startAutoResume()
    await startAutoResume()

    expect(S.llmCalls).toBe(1)
    expect(runCount()).toBe(2)
  })

  it('failed run 不自动重试（失败单步只由用户手动触发）', async () => {
    const convId = newConversation('失败不自动')
    seedFailed(convId, 'req-failed')

    await startAutoResume()

    expect(S.llmCalls).toBe(0)
    expect(runCount()).toBe(1)
    expect(conversationRunRepo.getLatest(convId)?.status).toBe('failed')
  })

  it('blocked 候选（工作目录变了）不发模型，也不新建 run', async () => {
    const oldDir = path.join(P.data, 'old-workspace')
    fs.mkdirSync(oldDir, { recursive: true })
    const convId = newConversation('目录变了')
    seedReady(convId, 'req-blocked', oldDir)
    conversationRunRepo.interruptActive()

    await startAutoResume()

    expect(S.llmCalls).toBe(0)
    expect(runCount()).toBe(1)
    expect(conversationRunRepo.getLatest(convId)?.status).toBe('interrupted')
  })

  it('两个会话各有候选 ⇒ 各自续跑，互不串台', async () => {
    const a = newConversation('会话 A')
    const b = newConversation('会话 B')
    seedReady(a, 'req-a')
    seedReady(b, 'req-b')
    conversationRunRepo.interruptActive()

    await startAutoResume()

    expect(S.llmCalls).toBe(2)
    expect(runCount()).toBe(4)
    expect(conversationRunRepo.getLatest(a)?.status).toBe('done')
    expect(conversationRunRepo.getLatest(b)?.status).toBe('done')
  })
})
