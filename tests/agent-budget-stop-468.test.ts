// Agent 循环金额预算触顶的集成用例（V4-Iter-468）。
//
// 复现口径：预算判定用 spy 桩成「已超限」，不依赖真实金额与计价表；
// 假 adapter 的 streamChat 只要被调一次就说明闸门没拦住。
// 断言：一次 LLM 都不发、一条工具消息都不落、assistant 收尾消息 status='done'
// 且内容为固定文案、没有 AGENT_ERROR_EVENT、运行态正常收尾为 done。
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-budget-stop'
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

// 假 adapter：任何一次调用都记下来；测试断言它从未被调用
const A = vi.hoisted(() => ({ streamChat: vi.fn() }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({ streamChat: A.streamChat })
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { agentEngine } from '../src/main/agent/engine'
import { usageService } from '../src/main/usage/usage-service'
import { getRuntimeSnapshot } from '../src/main/chat/runtime-registry'
import {
  IPC,
  type AgentDoneEvent,
  type AgentErrorEvent,
  type AgentStepEvent,
  type SendMessagePayload
} from '../src/shared/types'

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
    name: 'p-budget-stop',
    baseUrl: 'http://127.0.0.1:1/v1', // 不会被真实调用（adapter 已桩）
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({ name: 'a-budget-stop', toolPermissions: ['*'] }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  A.streamChat.mockClear()
})

describe('Agent 循环金额预算触顶：收尾停止，不再发模型/不再执行工具', () => {
  it('已超预算 ⇒ 零 LLM 调用、零工具消息、固定收尾文案落 done、无 error 事件', async () => {
    // 预算判定桩成已超限（不依赖真实金额/计价表）
    vi.spyOn(usageService, 'getHardBlockExceeded').mockReturnValue({
      scope: 'daily',
      cost: 12.5,
      limit: 10,
      currency: 'CNY',
      symbol: '¥'
    })

    const requestId = 'rq-budget-stop-' + Math.random().toString(36).slice(2)
    const conv = conversationRepo.create({ assistantId, title: 't', titleDefault: false })
    const payload = {
      requestId,
      conversationId: conv.id,
      content: '帮我查一下资料',
      assistantId,
      targets: [{ providerId, model: 'm1' }],
      agentMode: true
    } as unknown as SendMessagePayload

    const errs: AgentErrorEvent[] = []
    const steps: AgentStepEvent[] = []
    const doneEvts: AgentDoneEvent[] = []
    const emit = (channel: string, data: unknown): void => {
      if (channel === IPC.AGENT_ERROR_EVENT) errs.push(data as AgentErrorEvent)
      else if (channel === IPC.AGENT_STEP_EVENT) steps.push(data as AgentStepEvent)
      else if (channel === IPC.AGENT_DONE_EVENT) doneEvts.push(data as AgentDoneEvent)
    }

    await expect(agentEngine.run(payload, emit)).resolves.toBeUndefined()

    // 1) 不再发起 LLM 调用（含规划、摘要、主循环、降级）
    expect(A.streamChat, '触顶后一次模型调用都不许发').not.toHaveBeenCalled()

    // 2) 收尾不是错误路径
    expect(errs, '预算触顶走收尾停止，不发 AGENT_ERROR_EVENT').toHaveLength(0)

    const msgs = messageRepo.listByConversation(conv.id)
    // 3) 不再执行工具：没有任何 tool 消息
    expect(msgs.filter((m) => m.role === 'tool'), '触顶后不再执行工具').toHaveLength(0)
    expect(msgs.filter((m) => m.status === 'streaming'), '不允许残留 streaming 占位').toHaveLength(0)
    expect(msgs.filter((m) => m.role === 'assistant' && m.status === 'error')).toHaveLength(0)

    // 4) 固定收尾文案已落库，且是 done 终态
    const assistant = msgs.find((m) => m.role === 'assistant' && m.status === 'done')
    expect(assistant, '必须写入一条 done 的 assistant 收尾消息').toBeDefined()
    expect(assistant!.content).toContain('今日预算上限')
    expect(assistant!.content).toContain('¥10.00')
    expect(assistant!.content).toContain('本轮已停止继续调用模型')

    // 5) DONE 事件带同一段文案；final 步事件也收口
    expect(doneEvts).toHaveLength(1)
    expect(doneEvts[0]?.fullContent).toBe(assistant!.content)
    expect(
      steps.some((e) => e.type === 'final' && e.done === true && e.text === assistant!.content),
      'final 步事件应携带固定收尾文案并置 done'
    ).toBe(true)

    // 6) 运行态正常收尾：done 与 aborted 都会移出注册表（见 runtime-registry:157），
    //    这里断言"没有残留的活跃/失败登记"，不是 failed/悬挂
    expect(getRuntimeSnapshot().find((e) => e.conversationId === conv.id)).toBeUndefined()
  }, 60_000)
})
