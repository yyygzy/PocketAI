// @vitest-environment node
// P1-3b / P1-3c 真实库路径：
//   · 完成判定只认产物：assistant 是 done + 每个 tool_call 都有 done 的 tool 应答；
//   · 已完成工具步的断点续跑：不重放工具、只发一次下一步 LLM；
//   · 半截工具批次（有 call 没应答）绝不续跑；
//   · 失败的 run 停在模型步 ⇒ 只重试该步（一次 LLM，零工具调用），其余步骤调用次数为零。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-resume-p13bc'
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

/** 每次 streamChat 都记下来：用例要证明"只发了一次、发的是什么上下文" */
let llmCalls = 0
let lastMessages: Array<Record<string, unknown>> = []
let llmShouldThrow = false
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async (messages: Array<Record<string, unknown>>) => {
        llmCalls += 1
        lastMessages = messages
        if (llmShouldThrow) throw new Error('provider 500')
        return { content: '重试后的回答', toolCalls: [] }
      }
    })
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { conversationRepo } from '../src/main/db/repositories/conversation.repo'
import { messageRepo } from '../src/main/db/repositories/message.repo'
import { conversationRunRepo, judgeRunResume } from '../src/main/db/repositories/conversation-run.repo'
import { setRuntimePersistence, resetRuntimeRegistryForTest } from '../src/main/chat/runtime-registry'
import { chatService } from '../src/main/chat/chat-service'
import { IPC } from '../src/shared/types'
import type { MessageRecord, ToolCall } from '../src/shared/types'

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
    name: 'p-resume-steps',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  // 给一把真工具：若续跑真的重放了历史工具步，会留下新的 tool 消息与事件
  assistantId = assistantRepo.save({ name: 'a-resume-steps', toolPermissions: ['fs.read'] }).id
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
  lastMessages = []
  llmShouldThrow = false
})

function newConversation(title = '续跑步'): string {
  const conv = conversationRepo.create({ assistantId, title, titleDefault: false })
  conversationRepo.setRunState(conv.id, { modelLabel: `${providerId}:m1`, agentMode: true })
  return conv.id
}

const anchorOf = (convId: string): MessageRecord =>
  messageRepo.insert({ conversationId: convId, role: 'user', content: '原始提问', status: 'done' })

/** 种一条旧失败留下的 error 占位（挂同一个锚点，落在失败 run 的时间窗里） */
function seedErrorPlaceholder(convId: string, anchor: MessageRecord): MessageRecord {
  return messageRepo.insert({
    conversationId: convId,
    role: 'assistant',
    content: '（出错：provider 500）',
    status: 'error',
    parentId: anchor.id
  })
}

/** 种一个"已经做完的工具步"：assistant 带 tool_calls，回答齐全的 tool 消息挂在其下 */
function seedToolStep(
  convId: string,
  anchor: MessageRecord,
  calls: ToolCall[],
  answeredIds: string[]
): void {
  const assistant = messageRepo.insert({
    conversationId: convId,
    role: 'assistant',
    content: '我先读一下文件',
    status: 'done',
    parentId: anchor.id
  })
  messageRepo.updateToolCalls(assistant.id, JSON.stringify(calls))
  for (const id of answeredIds) {
    messageRepo.insert({
      conversationId: convId,
      role: 'tool',
      content: JSON.stringify({
        toolCallId: id,
        name: calls.find((c) => c.id === id)?.function.name ?? 'fs_read',
        arguments: '{}',
        content: `结果 ${id}`,
        isError: false
      }),
      status: 'done',
      parentId: assistant.id
    })
  }
}

const call = (id: string): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'fs_read', arguments: JSON.stringify({ path: 'a.txt' }) }
})

/** 种一条"上一进程停在 model 步"的中断行，并跑启动对账 */
function seedInterrupted(
  convId: string,
  requestId: string,
  anchor: MessageRecord,
  checkpoint: { stage: 'model' | 'tools'; stepsDone: number; toolStepsDone: number }
): void {
  conversationRunRepo.start({
    requestId,
    conversationId: convId,
    mode: 'agent',
    startedAt: Date.now() - 1000,
    anchorUserMessageId: anchor.id
  })
  conversationRunRepo.checkpoint(requestId, checkpoint)
  conversationRunRepo.interruptActive()
}

const toolMessages = (convId: string): MessageRecord[] =>
  messageRepo.listByConversation(convId).filter((m) => m.role === 'tool')
const userMessages = (convId: string): MessageRecord[] =>
  messageRepo.listByConversation(convId).filter((m) => m.role === 'user')

/** 收集引擎事件里"有没有真的碰工具"的证据 */
function collectEvents(): { events: Array<Record<string, unknown>>; sink: (channel: string, data: unknown) => void } {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    sink: (channel, data) => {
      if (channel === IPC.AGENT_STEP_EVENT) events.push(data as Record<string, unknown>)
    }
  }
}

describe('judgeRunResume：完成判定只认产物', () => {
  const base = {
    mode: 'agent' as const,
    anchorUserMessageId: 'msg-u',
    toolStepsDone: 1
  }

  it('工具步全部应答且完成步数对齐 ⇒ resumable（不再因 toolStepsDone>0 一律 restart）', () => {
    expect(
      judgeRunResume({
        ...base,
        stage: 'model',
        stepsDone: 2,
        doneAssistantCount: 1,
        toolMessageCount: 1,
        settledToolSteps: 1,
        danglingToolCalls: 0
      })
    ).toBe('resumable')
  })

  it('停在 tools 且该步已全部落库 ⇒ 完成步数比 steps_done 多 1，仍可续', () => {
    expect(
      judgeRunResume({
        ...base,
        stage: 'tools',
        stepsDone: 1,
        doneAssistantCount: 1,
        toolMessageCount: 1,
        settledToolSteps: 1,
        danglingToolCalls: 0
      })
    ).toBe('resumable')
  })

  it('有 tool_call 没应答 ⇒ 半截批次，一律 restart', () => {
    expect(
      judgeRunResume({
        ...base,
        stage: 'model',
        stepsDone: 2,
        doneAssistantCount: 1,
        toolMessageCount: 1,
        settledToolSteps: 0,
        danglingToolCalls: 1
      })
    ).toBe('restart')
  })

  it('失败 run 只有停在模型步才可按步重试', () => {
    const facts = {
      doneAssistantCount: 1,
      toolMessageCount: 1,
      settledToolSteps: 1,
      danglingToolCalls: 0
    }
    expect(
      judgeRunResume({ ...base, ...facts, status: 'failed', stage: 'model', stepsDone: 2 })
    ).toBe('resumable')
    expect(
      judgeRunResume({ ...base, ...facts, status: 'failed', stage: 'tools', stepsDone: 1 })
    ).toBe('restart')
  })
})

describe('P1-3b：已完成工具步的续跑', () => {
  it('准入口给 ready，续跑只发一次下一步 LLM、不重放工具', async () => {
    const convId = newConversation('P1-3b')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    seedInterrupted(convId, 'req-3b', anchor, { stage: 'model', stepsDone: 2, toolStepsDone: 1 })

    expect(conversationRunRepo.getLatest(convId)?.resumeState).toBe('resumable')
    const cand = chatService.getResumeCandidate(convId)
    expect(cand).toEqual(expect.objectContaining({ state: 'ready', kind: 'interrupted', nextStep: 3 }))

    const { events, sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-3b-new', conversationId: convId, resumeFromRequestId: 'req-3b' },
      sink
    )

    // 只发了失败步之后的那一次模型调用（没有重跑前面的步骤）
    expect(llmCalls).toBe(1)
    // 发出去的上下文里带着已完成的工具步：assistant 的 tool_calls 与它的 tool 应答
    expect(lastMessages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true)
    expect(lastMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true)
    // 没有重放：没有新的工具消息，也没有 tool_call/tool_result 事件
    expect(toolMessages(convId)).toHaveLength(1)
    expect(events.some((e) => e.type === 'tool_call' || e.type === 'tool_result')).toBe(false)
    // 只新增了一条 assistant（下一步那一次），前面的步骤一条都没被重跑
    expect(
      messageRepo.listByConversation(convId).filter((m) => m.role === 'assistant' && m.status === 'done')
    ).toHaveLength(2)
    // 用户消息没有变成两条
    expect(userMessages(convId)).toHaveLength(1)
    // 审计列继承旧值，而不是清零
    expect(conversationRunRepo.getLatest(convId)?.toolStepsDone).toBe(1)
  })

  it('停在 tools 但该步已全部落库 ⇒ 从完成步数接上（下一步步号 3，不是 2）', async () => {
    const convId = newConversation('P1-3b-tools')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    seedInterrupted(convId, 'req-3b-tools', anchor, { stage: 'tools', stepsDone: 1, toolStepsDone: 1 })

    const cand = chatService.getResumeCandidate(convId)
    expect(cand).toEqual(expect.objectContaining({ state: 'ready', nextStep: 3 }))

    const { events, sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-3b-tools-new', conversationId: convId, resumeFromRequestId: 'req-3b-tools' },
      sink
    )

    expect(llmCalls).toBe(1)
    expect(events.some((e) => e.type === 'tool_call' || e.type === 'tool_result')).toBe(false)
    expect(toolMessages(convId)).toHaveLength(1)
    const row = conversationRunRepo.getLatest(convId)!
    expect(row.status).toBe('done')
    expect(row.stepsDone).toBe(2)
  })

  it('半截工具批次（2 个 call 只答了 1 个）⇒ 启动判 restart、无候选', () => {
    const convId = newConversation('P1-3b-partial')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1'), call('call_2')], ['call_1'])
    seedInterrupted(convId, 'req-3b-partial', anchor, { stage: 'model', stepsDone: 2, toolStepsDone: 1 })

    expect(conversationRunRepo.getLatest(convId)?.resumeState).toBe('restart')
    expect(chatService.getResumeCandidate(convId)).toBeNull()
    expect(llmCalls).toBe(0)
  })
})

describe('P1-3c：失败只重试该步', () => {
  it('停在模型步的失败 ⇒ 候选 kind=failed，重试只发一次 LLM、零工具调用', async () => {
    const convId = newConversation('P1-3c')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    // 失败的 run：第 1 步模型、第 2 步工具都完成，第 3 步模型失败
    conversationRunRepo.start({
      requestId: 'req-3c',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now() - 1000,
      anchorUserMessageId: anchor.id
    })
    conversationRunRepo.checkpoint('req-3c', { stage: 'model', stepsDone: 2, toolStepsDone: 1 })
    const stale = seedErrorPlaceholder(convId, anchor)
    conversationRunRepo.finish('req-3c', 'failed', 'provider 500')

    const cand = chatService.getResumeCandidate(convId)
    expect(cand).toEqual(expect.objectContaining({ state: 'ready', kind: 'failed', nextStep: 3 }))

    const { events, sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-3c-retry', conversationId: convId, resumeFromRequestId: 'req-3c' },
      sink
    )

    // 只调用失败的那一步一次；前面已完成的步骤调用次数为零
    expect(llmCalls).toBe(1)
    expect(events.filter((e) => e.type === 'thought').length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'tool_call' || e.type === 'tool_result')).toBe(false)
    // 只新增了一条 assistant（重试的那一步），更早的步骤没有被重跑
    expect(
      messageRepo.listByConversation(convId).filter((m) => m.role === 'assistant' && m.status === 'done')
    ).toHaveLength(2)
    // 已完成的工具步没有被重跑（tool 消息仍是 1 条），用户消息也没有重发
    expect(toolMessages(convId)).toHaveLength(1)
    expect(userMessages(convId)).toHaveLength(1)
    // 旧失败留下的 error 占位在成功后清掉，不留一张"又错了一次"的假卡
    expect(messageRepo.getById(stale.id)).toBeNull()
    // 旧行保持 failed 作审计；新行是新 requestId 且完成
    expect(conversationRunRepo.getByRequest('req-3c')?.status).toBe('failed')
    const latest = conversationRunRepo.getLatest(convId)!
    expect(latest.requestId).toBe('req-3c-retry')
    expect(latest.status).toBe('done')
    expect(latest.stepsDone).toBe(2)
    expect(latest.toolStepsDone).toBe(1)
  })

  it('重试仍然失败 ⇒ 旧错误占位保留，不把失败痕迹抹掉', async () => {
    const convId = newConversation('P1-3c-keep-error')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    conversationRunRepo.start({
      requestId: 'req-3c-keep',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now() - 1000,
      anchorUserMessageId: anchor.id
    })
    conversationRunRepo.checkpoint('req-3c-keep', { stage: 'model', stepsDone: 2, toolStepsDone: 1 })
    const stale = seedErrorPlaceholder(convId, anchor)
    conversationRunRepo.finish('req-3c-keep', 'failed', 'provider 500')

    llmShouldThrow = true
    const { sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-3c-keep-retry', conversationId: convId, resumeFromRequestId: 'req-3c-keep' },
      sink
    )

    expect(messageRepo.getById(stale.id)).not.toBeNull()
    expect(conversationRunRepo.getByRequest('req-3c-keep-retry')?.status).toBe('failed')
  })

  it('只删旧 run 时间窗内、同锚点、未留痕的 error；其他错误一律保留', async () => {
    const convId = newConversation('P1-3c-cleanup-boundary')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    conversationRunRepo.start({
      requestId: 'req-3c-boundary',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now() - 1000,
      anchorUserMessageId: anchor.id
    })
    conversationRunRepo.checkpoint('req-3c-boundary', { stage: 'model', stepsDone: 2, toolStepsDone: 1 })

    const stale = seedErrorPlaceholder(convId, anchor)
    const starred = seedErrorPlaceholder(convId, anchor)
    messageRepo.setStarred(starred.id, true)
    const pinned = seedErrorPlaceholder(convId, anchor)
    messageRepo.setPinned(pinned.id, true)
    const otherAnchor = messageRepo.insert({
      conversationId: convId,
      role: 'assistant',
      content: '别的锚点下的错误',
      status: 'error',
      parentId: 'other-anchor'
    })
    conversationRunRepo.finish('req-3c-boundary', 'failed', 'provider 500')
    // run 结束之后才出现的错误：不属于旧 run 的占位（错开毫秒，避免同毫秒边界含糊）
    await new Promise((resolve) => setTimeout(resolve, 2))
    const late = seedErrorPlaceholder(convId, anchor)

    const { sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-3c-boundary-retry', conversationId: convId, resumeFromRequestId: 'req-3c-boundary' },
      sink
    )

    expect(messageRepo.getById(stale.id)).toBeNull()
    expect(messageRepo.getById(starred.id)).not.toBeNull()
    expect(messageRepo.getById(pinned.id)).not.toBeNull()
    expect(messageRepo.getById(otherAnchor.id)).not.toBeNull()
    expect(messageRepo.getById(late.id)).not.toBeNull()
  })

  it('失败落在工具步 ⇒ 不给"只重试该步"入口', () => {
    const convId = newConversation('P1-3c-tools')
    const anchor = anchorOf(convId)
    seedToolStep(convId, anchor, [call('call_1')], ['call_1'])
    conversationRunRepo.start({
      requestId: 'req-3c-tools',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now() - 1000,
      anchorUserMessageId: anchor.id
    })
    conversationRunRepo.checkpoint('req-3c-tools', { stage: 'tools', stepsDone: 1, toolStepsDone: 1 })
    conversationRunRepo.finish('req-3c-tools', 'failed', '工具步炸了')

    expect(chatService.getResumeCandidate(convId)).toBeNull()
  })
})
