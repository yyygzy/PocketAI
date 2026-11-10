// @vitest-environment node
// Agent 降级步骤失败的占位消息收尾测试（缺陷：runDegradeStep 在 try 内插入
// status='streaming' 的 degradeMsg，catch 只发错误事件、不写终态，外层在失败时直接
// return 也指望不上主循环的清理 ⇒ DB 永久留一条空 streaming 行，导出/上下文重建都会带上）。
//
// 复现路径：假 adapter 在正常步骤永远返回同一个「不存在工具」的 tool_call（触发
// 步数耗尽 → 重规划一次 → 再耗尽 → 降级），降级调用（不带 tools 参数）直接抛错。
// 断言：degradeMsg 被收尾为 error 终态、运行态注册表标 failed、发出 AGENT_ERROR_EVENT、
// 全会话没有任何 streaming 残留。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-degrade-cleanup'
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

// 假 adapter：带 tools 的正常步骤返回未知工具调用（让步数耗尽走到降级）；
// 不带 tools 的调用 = 降级那一次，直接抛错
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async (_messages: unknown, params: { tools?: unknown }) => {
        if (params.tools === undefined) throw new Error('降级通道故障（模拟）')
        return {
          content: '',
          toolCalls: [{ id: 'tc-1', function: { name: 'no_such_tool_xyz', arguments: '{}' } }]
        }
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
import { getRuntimeSnapshot } from '../src/main/chat/runtime-registry'
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
    name: 'p-degrade',
    baseUrl: 'http://127.0.0.1:1/v1', // 不会被真实调用（adapter 已桩）
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({ name: 'a-degrade', toolPermissions: ['*'] }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('runDegradeStep 失败收尾：占位消息写终态，不留永久 streaming 空行', () => {
  it('降级 LLM 抛错 ⇒ degradeMsg 收尾为 error、运行态 failed、发 AGENT_ERROR_EVENT、无 streaming 残留', async () => {
    const requestId = 'rq-degrade-' + Math.random().toString(36).slice(2)
    const conv = conversationRepo.create({ assistantId, title: 't', titleDefault: false })
    const payload = {
      requestId,
      conversationId: conv.id,
      content: '开始',
      assistantId,
      targets: [{ providerId, model: 'm1' }],
      agentMode: true
    } as unknown as SendMessagePayload

    const errs: AgentErrorEvent[] = []
    const emit = (channel: string, data: unknown): void => {
      if (channel === IPC.AGENT_ERROR_EVENT) errs.push(data as AgentErrorEvent)
    }

    await expect(agentEngine.run(payload, emit)).resolves.toBeUndefined()

    expect(errs.length).toBeGreaterThanOrEqual(1)
    expect(String(errs[errs.length - 1]?.error)).toContain('降级总结失败')
    // conversations.status 已停写：运行态唯一事实源是 runtime-registry（B-2/B-3）
    expect(getRuntimeSnapshot().find((e) => e.conversationId === conv.id)?.state).toBe('failed')

    const msgs = messageRepo.listByConversation(conv.id)
    const streaming = msgs.filter((m) => m.status === 'streaming')
    expect(streaming, '降级失败后不允许残留 streaming 占位消息').toHaveLength(0)
    const degradeMsg = msgs.find((m) => m.content.includes('降级总结失败'))
    expect(degradeMsg, '降级占位消息应被写入失败文案').toBeDefined()
    expect(degradeMsg!.status).toBe('error')
  }, 60_000)
})
