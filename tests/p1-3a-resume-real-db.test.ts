// @vitest-environment node
// P1-3a 长任务续跑（v1）真实库路径：
//   · v73 三列（锚点 / 工作目录 / 授权签名）由 start / setAnchor / checkpoint 落地；
//   · 启动对账 + 准入：可续、被拦（目录变/授权变/产物对不齐/已有工具消息）、根本不可续；
//   · 引擎续跑：不重复插用户消息、不重跑标题/规划、步号从 N+1 起、不执行工具；
//   · 服务入口：fail-closed 时不调模型，成功时重建 payload（目标取自会话 modelLabel）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-resume-p13a'
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
  powerSaveBlocker: { start: () => 1, stop: () => {} },
  ipcMain: { handle: () => {}, on: () => {} }
}))

/** 模型调用计数：fail-closed 的用例必须证明"根本没走到模型" */
let llmCalls = 0
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async () => {
        llmCalls += 1
        return { content: '收尾回答', toolCalls: [] }
      }
    })
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { conversationRunRepo } from '../src/main/db/repositories/conversation-run.repo'
import { setRuntimePersistence, resetRuntimeRegistryForTest } from '../src/main/chat/runtime-registry'
import { chatService } from '../src/main/chat/chat-service'
import { agentEngine } from '../src/main/agent/engine'
import { IPC } from '../src/shared/types'
import type { MessageRecord, SendMessagePayload } from '../src/shared/types'

setRuntimePersistence(conversationRunRepo)

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
    name: 'p-resume',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  // 无工具授权：一轮就是一次 LLM 调用，任何工具执行都会立刻在教育性断言里暴露
  assistantId = assistantRepo.save({ name: 'a-resume', toolPermissions: [] }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* ignore */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  resetRuntimeRegistryForTest()
  llmCalls = 0
})

function newConversation(title = '续跑'): string {
  const conv = conversationRepo.create({ assistantId, title, titleDefault: false })
  conversationRepo.setRunState(conv.id, { modelLabel: `${providerId}:m1`, agentMode: true })
  return conv.id
}

/** 造一条锚点用户消息 + n 条已完成助手消息（产物条数要和 steps_done 对齐） */
function seedMessages(convId: string, doneAssistants: number): MessageRecord {
  const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: '原始提问', status: 'done' })
  for (let i = 0; i < doneAssistants; i++) {
    messageRepo.insert({
      conversationId: convId,
      role: 'assistant',
      content: `第 ${i + 1} 步`,
      status: 'done',
      parentId: anchor.id
    })
  }
  return anchor
}

/** 种一条"上一进程里跑到 model 步就崩了"的 run 行，并跑一次启动对账 */
function seedInterruptedRun(args: {
  convId: string
  requestId: string
  anchor: MessageRecord
  stepsDone: number
  workspaceDir?: string | null
  sig?: string | null
}): void {
  conversationRunRepo.start({
    requestId: args.requestId,
    conversationId: args.convId,
    mode: 'agent',
    startedAt: Date.now() - 1000,
    anchorUserMessageId: args.anchor.id,
    workspaceDir: args.workspaceDir ?? null,
    toolPermissionsSig: args.sig ?? null
  })
  conversationRunRepo.checkpoint(args.requestId, {
    stage: 'model',
    stepsDone: args.stepsDone,
    toolStepsDone: 0
  })
  conversationRunRepo.interruptActive()
}

const userMessages = (convId: string): MessageRecord[] =>
  messageRepo.listByConversation(convId).filter((m) => m.role === 'user')

describe('v73：三列落库与准入', () => {
  it('start/setAnchor/checkpoint 都把快照写在同一行上', () => {
    const convId = newConversation()
    conversationRunRepo.start({
      requestId: 'req-cols',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now(),
      anchorUserMessageId: 'msg-anchor',
      workspaceDir: 'C:/工作区'
    })
    conversationRunRepo.checkpoint('req-cols', {
      stage: 'model',
      stepsDone: 0,
      toolStepsDone: 0,
      toolPermissionsSig: 'sig-1'
    })
    const row = conversationRunRepo.getLatest(convId)!
    expect(row.anchorUserMessageId).toBe('msg-anchor')
    expect(row.workspaceDir).toBe('C:/工作区')
    expect(row.toolPermissionsSig).toBe('sig-1')
    expect(row.status).toBe('running')

    // 后续检查点不带快照，不能把已有值覆盖成空
    conversationRunRepo.checkpoint('req-cols', { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    expect(conversationRunRepo.getLatest(convId)?.workspaceDir).toBe('C:/工作区')
    // setAnchor 只补锚点
    conversationRunRepo.setAnchor('req-cols', 'msg-anchor-2')
    expect(conversationRunRepo.getLatest(convId)?.anchorUserMessageId).toBe('msg-anchor-2')
  })

  it('可续：agent + 锚点 + 产物对齐 ⇒ ready，nextStep = steps_done + 1', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 1)
    seedInterruptedRun({ convId, requestId: 'req-ready', anchor, stepsDone: 1 })

    const cand = chatService.getResumeCandidate(convId)
    expect(cand).toEqual(
      expect.objectContaining({ requestId: 'req-ready', state: 'ready', nextStep: 2, userMessageId: anchor.id })
    )
  })

  it('工作目录已变 ⇒ blocked（fail-closed）', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-dir', anchor, stepsDone: 0, workspaceDir: 'C:/别的工作区' })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_WORKSPACE_CHANGED' })
    )
  })

  it('工具授权已变 ⇒ blocked（fail-closed）', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-perm', anchor, stepsDone: 0, sig: '旧的授权签名' })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_PERMISSIONS_CHANGED' })
    )
  })

  it('产物条数与 steps_done 对不齐 ⇒ 启动判定就只给 restart（不猜"模型答完了但检查点没写"的窗口）', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    // 故意让 DB 里的 steps_done=1，但只落库了 0 条助手消息
    seedInterruptedRun({ convId, requestId: 'req-gap', anchor, stepsDone: 1 })

    // 启动对账已经把这行判成 restart：侧栏说"需重新开始"，不给入口（比点了再报错更诚实）
    expect(conversationRunRepo.getLatest(convId)?.resumeState).toBe('restart')
    expect(chatService.getResumeCandidate(convId)).toBeNull()
  })

  it('启动之后产物又变了 ⇒ blocked（点击时还要复核一次）', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-gap2', anchor, stepsDone: 0 })
    // 对账时 0 条助手消息、steps_done=0 是对齐的；之后多出一条就说明断点记录已不可信
    messageRepo.insert({
      conversationId: convId,
      role: 'assistant',
      content: '后写进来的一条',
      status: 'done',
      parentId: anchor.id
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_ARTIFACTS_MISMATCH' })
    )
  })

  it('启动对账之后才出现的工具消息 ⇒ blocked（工具可能已执行，绝不重放）', () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-tool', anchor, stepsDone: 0 })
    // 对账时还是 resumable，之后多出一条 tool 消息（模拟另一路径写进来的副作用）
    const assistant = messageRepo.insert({
      conversationId: convId,
      role: 'assistant',
      content: '要调工具',
      status: 'done',
      parentId: anchor.id
    })
    messageRepo.insert({
      conversationId: convId,
      role: 'tool',
      content: '{"ok":true}',
      status: 'done',
      parentId: assistant.id
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOLS_EXECUTED' })
    )
  })

  it('没有断点 / 已有更新的一轮 / 没有锚点的老行 ⇒ 不给候选', () => {
    const empty = newConversation()
    expect(chatService.getResumeCandidate(empty)).toBeNull()

    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-old', anchor, stepsDone: 0 })
    // 崩溃后用户又发了一轮并正常结束：最新的 run 是 done，旧断点不能再续
    conversationRunRepo.start({ requestId: 'req-newer', conversationId: convId, mode: 'agent', startedAt: Date.now() })
    conversationRunRepo.finish('req-newer', 'done')
    expect(chatService.getResumeCandidate(convId)).toBeNull()
  })
})

describe('引擎续跑（P1-3a）', () => {
  it('不重复插用户消息、不重跑标题、步号从 N+1 起、不执行工具', async () => {
    const convId = newConversation('原标题')
    const anchor = seedMessages(convId, 3)
    const events: Array<Record<string, unknown>> = []

    await agentEngine.run(
      {
        requestId: 'req-engine',
        conversationId: convId,
        content: anchor.content,
        assistantId,
        targets: [{ providerId, model: 'm1' }],
        agentMode: true
      } as unknown as SendMessagePayload,
      (channel, data) => {
        if (channel === IPC.AGENT_STEP_EVENT) events.push(data as Record<string, unknown>)
        else events.push({ channel, data })
      },
      {
        resume: {
          userMessage: anchor,
          startStep: 3,
          startToolStepsDone: 0,
          workspaceDir: null,
          toolPermissionsSig: null
        }
      }
    )

    // 续跑这一轮必须真的跑成（引擎 setup 段的兜底 catch 会吞掉异常，这里钉住没有错误事件）
    expect(events.filter((e) => e.channel === IPC.AGENT_ERROR_EVENT)).toEqual([])
    // 用户消息没有变成两条
    expect(userMessages(convId)).toHaveLength(1)
    // 没有 emit user 事件（渲染端不会再多插一张卡）
    expect(events.some((e) => e.type === 'user')).toBe(false)
    // 第一步的步号是 4（3 + 1），不是 1
    expect(events.some((e) => e.type === 'thought' && e.stepIndex === 4)).toBe(true)
    // 没有工具消息（这一轮本来就没有工具授权；续跑也不该凭空执行）
    expect(messageRepo.listByConversation(convId).filter((m) => m.role === 'tool')).toHaveLength(0)
    // 标题生成被跳过（续跑不是"首轮消息"）
    expect(conversationRepo.get(convId)?.title).toBe('原标题')
    // 只调了一次模型（规划是旁路调用，续跑跳过）
    expect(llmCalls).toBe(1)
  })
})

describe('服务入口 chatService.resume', () => {
  it('成功续跑：新 requestId、不重复用户消息、旧 run 行保留', async () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-svc-old', anchor, stepsDone: 0 })

    await chatService.resume(
      { requestId: 'req-svc-new', conversationId: convId, resumeFromRequestId: 'req-svc-old' },
      () => {}
    )

    expect(userMessages(convId)).toHaveLength(1)
    expect(llmCalls).toBe(1)
    // 旧行仍是 interrupted（审计保留），新行是新 requestId
    const oldRow = conversationRunRepo.getLatest(convId)!
    expect(oldRow.requestId).toBe('req-svc-new')
    expect(oldRow.status).toBe('done')
    const rows = dbService
      .getHandle()
      .prepare('SELECT request_id AS requestId, status FROM conversation_runs WHERE conversation_id=? ORDER BY started_at ASC')
      .all(convId) as Array<{ requestId: string; status: string }>
    expect(rows).toEqual([
      { requestId: 'req-svc-old', status: 'interrupted' },
      { requestId: 'req-svc-new', status: 'done' }
    ])
  })

  it('fail-closed：候选过期时停在 RESUME_STALE，且不调模型', async () => {
    const convId = newConversation()
    const anchor = seedMessages(convId, 0)
    seedInterruptedRun({ convId, requestId: 'req-stale', anchor, stepsDone: 0 })

    await expect(
      chatService.resume(
        { requestId: 'req-stale-new', conversationId: convId, resumeFromRequestId: 'req-not-this-one' },
        () => {}
      )
    ).rejects.toThrow(/^RESUME_STALE:/)
    expect(llmCalls).toBe(0)
    expect(userMessages(convId)).toHaveLength(1)
  })

  it('fail-closed：没有候选时说 RESUME_NOT_FOUND，且不调模型', async () => {
    const convId = newConversation()
    await expect(
      chatService.resume(
        { requestId: 'req-none', conversationId: convId, resumeFromRequestId: 'req-none-old' },
        () => {}
      )
    ).rejects.toThrow(/^RESUME_NOT_FOUND:/)
    expect(llmCalls).toBe(0)
  })
})
