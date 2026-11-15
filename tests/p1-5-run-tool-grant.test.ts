// @vitest-environment node
// P1-5：per-run 授权通道（第三刀）真实库路径。
//   1) 开关关闭 ⇒ 行为与今天完全一致：grant 被忽略，E=助手基线，scope 不落库；
//   2) 开关打开 ⇒ 越权/不可用的勾选在**建 run 之前**被拒（不写用户消息、不建运行行）；
//   3) 取消勾选 ⇒ 该工具在 run 内既不下发给模型，模型硬调也会被 classify 拒绝；
//   4) 续跑按落库的 scope 复核：模板勾选变了/模板被删/助手收回/工具消失分别分档；
//   5) 旧 run（scope 为空）继续走旧签名口径，不被误判。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-run-tool-grant-p15'
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

/** 记录每次 LLM 调用；toolQueue 决定"带 tools 的第 N 次调用"要请求哪个工具 */
let llmCalls = 0
let stubCalls: Array<{ messages: Array<Record<string, unknown>>; params: Record<string, unknown> }> = []
let toolQueue: string[] = []
let toolsCallCount = 0
const FINAL_TEXT = '本轮结束'

vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async (
        messages: Array<Record<string, unknown>>,
        params: Record<string, unknown>
      ) => {
        llmCalls += 1
        stubCalls.push({ messages, params })
        const tools = Array.isArray(params?.tools) ? (params.tools as Array<{ name: string }>) : null
        if (!tools) return { content: '计划/摘要', toolCalls: [] }
        const name = toolQueue[toolsCallCount]
        toolsCallCount += 1
        if (!name) return { content: FINAL_TEXT, toolCalls: [] }
        return {
          content: '',
          toolCalls: [
            { id: `call_${toolsCallCount}`, type: 'function', function: { name, arguments: '{}' } }
          ]
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
import { conversationRunRepo } from '../src/main/db/repositories/conversation-run.repo'
import { runbookRepo } from '../src/main/db/repositories/runbook.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import { setRuntimePersistence, resetRuntimeRegistryForTest } from '../src/main/chat/runtime-registry'
import { chatService } from '../src/main/chat/chat-service'
import { toolPermissionsSignature } from '../src/main/agent/tool-permissions'
import {
  PER_RUN_TOOL_GRANT_KEY,
  parseRunToolScope,
  resolveRunToolScope,
  sameToolSet
} from '../src/main/agent/run-tool-scope'
import { IPC } from '../src/shared/types'
import type { MessageRecord, SendMessagePayload, ToolCall } from '../src/shared/types'

setRuntimePersistence(conversationRunRepo)

let providerId = ''
let assistantId = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  // fs.* 是"按配置动态注册"的内置工具：没工作目录时注册表里根本没有它们，
  // 本文件要验证"工具面收窄/越权"，先给一个可用的工作目录。
  setWorkspaceDir(P.data)
  providerId = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: 'p-run-tool-grant',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKeys: [],
    models: ['m1'],
    enabled: true,
    createdAt: Date.now()
  }).id
  assistantId = assistantRepo.save({
    name: 'a-run-tool-grant',
    toolPermissions: ['fs.read', 'fs.write']
  }).id
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
  stubCalls = []
  toolQueue = []
  toolsCallCount = 0
  // 默认关闭：需要打开开关的用例自己 set('1')
  appConfigRepo.set(PER_RUN_TOOL_GRANT_KEY, '0')
})

function newConversation(title: string): string {
  const conv = conversationRepo.create({ assistantId, title, titleDefault: false })
  conversationRepo.setRunState(conv.id, { modelLabel: `${providerId}:m1`, agentMode: true })
  return conv.id
}

function sendPayload(
  convId: string,
  requestId: string,
  grant?: { runbookId: string; toolIds: string[] }
): SendMessagePayload {
  return {
    requestId,
    conversationId: convId,
    assistantId,
    content: '按模板做一遍',
    targets: [{ providerId, model: 'm1' }],
    agentMode: true,
    toolGrant: grant
  }
}

function collectEvents(): { events: Array<Record<string, unknown>>; sink: (channel: string, data: unknown) => void } {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    sink: (channel, data) => {
      if (channel === IPC.AGENT_STEP_EVENT) events.push(data as Record<string, unknown>)
    }
  }
}

const messagesOf = (convId: string, role: string): MessageRecord[] =>
  messageRepo.listByConversation(convId).filter((m) => m.role === role)

/** 模型侧真正拿到的那份工具清单（第一次带 tools 的调用；中断续跑同样适用） */
function firstToolsCall(): { names: string[]; params: Record<string, unknown> } | null {
  const hit = stubCalls.find((c) => Array.isArray(c.params?.tools))
  if (!hit) return null
  const tools = hit.params.tools as Array<{ name: string }>
  return { names: tools.map((t) => t.name), params: hit.params }
}

// ---------- 纯函数 ----------

describe('run-tool-scope 纯函数', () => {
  it('parseRunToolScope：NULL/坏 JSON/版本不符 ⇒ null；合法值去伪', () => {
    expect(parseRunToolScope(null)).toBeNull()
    expect(parseRunToolScope('')).toBeNull()
    expect(parseRunToolScope('{oops')).toBeNull()
    expect(parseRunToolScope(JSON.stringify({ v: 2, mode: 'runbook', toolIds: ['fs.read'] }))).toBeNull()
    expect(
      parseRunToolScope(JSON.stringify({ v: 1, mode: 'runbook', toolIds: ['fs.read', 3] }))
    ).toBeNull()
    expect(parseRunToolScope(JSON.stringify({ v: 1, mode: 'runbook', runbookId: 'rb', toolIds: ['fs.read'] })))
      .toEqual({ v: 1, mode: 'runbook', runbookId: 'rb', toolIds: ['fs.read'] })
  })

  it('sameToolSet：去重 + 顺序无关，多一个少一个都算变', () => {
    expect(sameToolSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameToolSet(['a', 'a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameToolSet(['a'], ['a', 'b'])).toBe(false)
    expect(sameToolSet([], [])).toBe(true)
  })

  it('resolveRunToolScope：去重收窄；越权/不可用/空勾选分别报错', () => {
    const ok = resolveRunToolScope(['fs.read', 'fs.write'], {
      runbookId: 'rb',
      toolIds: ['fs.read', 'fs.read']
    })
    expect(ok.effective).toEqual(['fs.read'])
    expect(ok.scope).toEqual({ v: 1, mode: 'runbook', runbookId: 'rb', toolIds: ['fs.read'] })

    expect(() =>
      resolveRunToolScope(['fs.read'], { runbookId: 'rb', toolIds: ['fs.write'] })
    ).toThrow(/RUN_TOOL_NOT_GRANTED:fs\.write/)
    expect(() =>
      resolveRunToolScope(['fs.read'], { runbookId: 'rb', toolIds: ['ghost.tool'] })
    ).toThrow(/RUN_TOOL_UNAVAILABLE:ghost\.tool/)
    expect(() => resolveRunToolScope(['*'], { runbookId: 'rb', toolIds: [] })).toThrow(
      /RUN_TOOL_NOT_GRANTED/
    )
  })
})

// ---------- repo ----------

describe('conversation_runs.tool_scope_json', () => {
  it('start 写入 scope；后续 checkpoint 不传时 COALESCE 不清空', () => {
    const convId = newConversation('repo-scope')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    const scopeJson = JSON.stringify({ v: 1, mode: 'runbook', runbookId: 'rb', toolIds: ['fs.read'] })
    conversationRunRepo.start({
      requestId: 'req-repo-scope',
      conversationId: convId,
      mode: 'agent',
      startedAt: Date.now(),
      anchorUserMessageId: anchor.id,
      toolPermissionsSig: toolPermissionsSignature(['fs.read']),
      toolScopeJson: scopeJson
    })
    conversationRunRepo.checkpoint('req-repo-scope', { stage: 'model', stepsDone: 1, toolStepsDone: 0 })
    expect(conversationRunRepo.getLatest(convId)?.toolScopeJson).toBe(scopeJson)
  })
})

// ---------- 开关关闭：与今天一致 ----------

describe('开关关闭', () => {
  it('grant 一律不认：E=助手基线、scope 为空、工具面不因 grant 收窄', async () => {
    const convId = newConversation('off-ignore')
    const { sink } = collectEvents()
    await chatService.send(
      sendPayload(convId, 'req-off', { runbookId: 'rb', toolIds: ['fs.read'] }),
      sink
    )

    const names = firstToolsCall()?.names ?? []
    expect(names).toContain('fs_read')
    expect(names).toContain('fs_write')

    const run = conversationRunRepo.getLatest(convId)!
    expect(run.toolScopeJson).toBeNull()
    expect(run.toolPermissionsSig).toBe(toolPermissionsSignature(['fs.read', 'fs.write']))
  })

  it('越权/空 grant 也不在启动前拒绝（开关没开就当没传）', async () => {
    const convId = newConversation('off-overreach')
    const { sink } = collectEvents()
    await expect(
      chatService.send(
        sendPayload(convId, 'req-off-bad', { runbookId: 'rb', toolIds: ['ghost.tool'] }),
        sink
      )
    ).resolves.toBeUndefined()
    expect(conversationRunRepo.getLatest(convId)?.toolScopeJson).toBeNull()
  })
})

// ---------- 开关打开：启动前复核 ----------

describe('开关打开：启动前复核', () => {
  it('越权勾选 ⇒ RUN_TOOL_NOT_GRANTED，零 LLM、零用户消息、零 run 行', async () => {
    appConfigRepo.set(PER_RUN_TOOL_GRANT_KEY, '1')
    const convId = newConversation('on-overreach')
    const { sink } = collectEvents()
    const narrowAssistant = assistantRepo.save({ name: 'a-narrow', toolPermissions: ['fs.read'] }).id
    const payload = { ...sendPayload(convId, 'req-on-bad', { runbookId: 'rb', toolIds: ['fs.write'] }), assistantId: narrowAssistant }

    await expect(chatService.send(payload, sink)).rejects.toThrow(/RUN_TOOL_NOT_GRANTED/)
    expect(llmCalls).toBe(0)
    expect(messagesOf(convId, 'user')).toHaveLength(0)
    expect(conversationRunRepo.getLatest(convId)).toBeNull()
  })

  it('本机没有的工具 ⇒ RUN_TOOL_UNAVAILABLE，同样不启动', async () => {
    appConfigRepo.set(PER_RUN_TOOL_GRANT_KEY, '1')
    const convId = newConversation('on-missing')
    const { sink } = collectEvents()
    await expect(
      chatService.send(sendPayload(convId, 'req-on-missing', { runbookId: 'rb', toolIds: ['ghost.tool'] }), sink)
    ).rejects.toThrow(/RUN_TOOL_UNAVAILABLE/)
    expect(llmCalls).toBe(0)
    expect(conversationRunRepo.getLatest(convId)).toBeNull()
  })

  it('取消勾选的工具：不下发给模型；模型硬调也被 classify 拒绝', async () => {
    appConfigRepo.set(PER_RUN_TOOL_GRANT_KEY, '1')
    const convId = newConversation('on-subset')
    toolQueue = ['fs_write'] // 模型硬调未勾选的 fs_write
    const { events, sink } = collectEvents()
    await chatService.send(
      sendPayload(convId, 'req-on-subset', { runbookId: 'rb', toolIds: ['fs.read'] }),
      sink
    )

    const names = firstToolsCall()?.names ?? []
    expect(names).toContain('fs_read')
    expect(names).not.toContain('fs_write')

    const denied = events.find(
      (e) => e.type === 'tool_result' && (e.toolResult as { isError?: boolean })?.isError === true
    )
    expect(denied).toBeTruthy()
    expect(String((denied!.toolResult as { content?: string }).content)).toContain('TOOL_NOT_ALLOWED')

    const run = conversationRunRepo.getLatest(convId)!
    expect(run.toolScopeJson).toBe(
      JSON.stringify({ v: 1, mode: 'runbook', runbookId: 'rb', toolIds: ['fs.read'] })
    )
    expect(run.toolPermissionsSig).toBe(toolPermissionsSignature(['fs.read']))
  })
})

// ---------- 续跑准入 ----------

const call = (id: string): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'fs_read', arguments: JSON.stringify({ path: 'a.txt' }) }
})

/** 种一个完整工具步：assistant(tool_calls) + 对应 tool 应答 */
function seedDoneToolStep(convId: string, anchor: MessageRecord): void {
  const assistant = messageRepo.insert({
    conversationId: convId,
    role: 'assistant',
    content: '读一下',
    status: 'done',
    parentId: anchor.id
  })
  const calls = [call('call_1')]
  messageRepo.updateToolCalls(assistant.id, JSON.stringify(calls))
  messageRepo.insert({
    conversationId: convId,
    role: 'tool',
    content: JSON.stringify({
      toolCallId: 'call_1',
      name: 'fs_read',
      arguments: '{}',
      content: '结果',
      isError: false
    }),
    status: 'done',
    parentId: assistant.id
  })
}

/** 种中断行（可带 scope/sig），并跑启动对账 */
function seedInterrupted(
  convId: string,
  requestId: string,
  anchor: MessageRecord,
  extra?: { toolScopeJson?: string | null; toolPermissionsSig?: string | null }
): void {
  conversationRunRepo.start({
    requestId,
    conversationId: convId,
    mode: 'agent',
    startedAt: Date.now() - 1000,
    anchorUserMessageId: anchor.id,
    ...extra
  })
  conversationRunRepo.checkpoint(requestId, { stage: 'model', stepsDone: 2, toolStepsDone: 1 })
  conversationRunRepo.interruptActive()
}

function makeRunbook(toolPermissions: string[]): string {
  return runbookRepo.insert({
    name: '模板',
    promptSummary: '按模板做一遍',
    steps: [{ toolName: 'fs_read', toolId: 'fs.read', argKeys: [] }],
    refs: [],
    toolPermissions
  }).id
}

describe('续跑：按落库 scope 复核', () => {
  it('模板勾选未变 ⇒ ready，且续跑工具面取 scope（不是当前助手基线）', async () => {
    appConfigRepo.set(PER_RUN_TOOL_GRANT_KEY, '1')
    const convId = newConversation('resume-ok')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: '原始提问', status: 'done' })
    seedDoneToolStep(convId, anchor)
    const runbookId = makeRunbook(['fs.read'])
    const scope = { v: 1, mode: 'runbook' as const, runbookId, toolIds: ['fs.read'] }
    seedInterrupted(convId, 'req-resume-ok', anchor, {
      toolScopeJson: JSON.stringify(scope),
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'ready', kind: 'interrupted', nextStep: 3 })
    )

    const { sink } = collectEvents()
    await chatService.resume(
      { requestId: 'req-resume-ok-new', conversationId: convId, resumeFromRequestId: 'req-resume-ok' },
      sink
    )
    expect(llmCalls).toBe(1)
    const names = firstToolsCall()?.names ?? []
    expect(names).toContain('fs_read')
    expect(names).not.toContain('fs_write')
    // 续跑不重写起点 scope
    expect(conversationRunRepo.getLatest(convId)?.toolScopeJson).toBe(JSON.stringify(scope))
  })

  it('中断后模板勾选被改 ⇒ RESUME_TOOL_GRANT_CHANGED', () => {
    const convId = newConversation('resume-grant-changed')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    const runbookId = makeRunbook(['fs.read'])
    seedInterrupted(convId, 'req-grant-changed', anchor, {
      toolScopeJson: JSON.stringify({ v: 1, mode: 'runbook', runbookId, toolIds: ['fs.read'] }),
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })
    runbookRepo.update(runbookId, { toolPermissions: ['fs.read', 'fs.write'] })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_GRANT_CHANGED' })
    )
  })

  it('中断后模板被删 ⇒ 同样按 RESUME_TOOL_GRANT_CHANGED 拒绝', () => {
    const convId = newConversation('resume-template-gone')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    const runbookId = makeRunbook(['fs.read'])
    seedInterrupted(convId, 'req-template-gone', anchor, {
      toolScopeJson: JSON.stringify({ v: 1, mode: 'runbook', runbookId, toolIds: ['fs.read'] }),
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })
    runbookRepo.delete(runbookId)

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_GRANT_CHANGED' })
    )
  })

  it('助手收回工具 ⇒ RESUME_TOOL_PERMISSIONS_REVOKED（与模板变更分开报）', () => {
    const convId = newConversation('resume-revoked')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    const runbookId = makeRunbook(['fs.read'])
    seedInterrupted(convId, 'req-revoked', anchor, {
      toolScopeJson: JSON.stringify({ v: 1, mode: 'runbook', runbookId, toolIds: ['fs.read'] }),
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })
    assistantRepo.save({ id: assistantId, name: 'a-run-tool-grant', toolPermissions: ['fs.write'] })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_PERMISSIONS_REVOKED' })
    )
  })

  it('工具已不在注册表 ⇒ RESUME_TOOL_UNAVAILABLE', () => {
    const convId = newConversation('resume-unavailable')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    const runbookId = makeRunbook(['ghost.tool'])
    seedInterrupted(convId, 'req-unavailable', anchor, {
      toolScopeJson: JSON.stringify({ v: 1, mode: 'runbook', runbookId, toolIds: ['ghost.tool'] }),
      toolPermissionsSig: toolPermissionsSignature(['ghost.tool'])
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_UNAVAILABLE' })
    )
  })

  it('旧 run（scope 为空）+ 签名一致 ⇒ 不被误判，可续', () => {
    const convId = newConversation('resume-legacy-ok')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    // 助手此时是 ['fs.write']（上一个用例改过），这里恢复成旧 run 起点的那份
    assistantRepo.save({ id: assistantId, name: 'a-run-tool-grant', toolPermissions: ['fs.read'] })
    seedInterrupted(convId, 'req-legacy-ok', anchor, {
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'ready', kind: 'interrupted' })
    )
  })

  it('旧 run（scope 为空）+ 签名不一致 ⇒ 仍按旧口径 RESUME_TOOL_PERMISSIONS_CHANGED', () => {
    const convId = newConversation('resume-legacy-changed')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    assistantRepo.save({ id: assistantId, name: 'a-run-tool-grant', toolPermissions: ['fs.read'] })
    seedInterrupted(convId, 'req-legacy-changed', anchor, {
      toolPermissionsSig: toolPermissionsSignature(['fs.write'])
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_PERMISSIONS_CHANGED' })
    )
  })

  it('scope 列非空但解析失败 ⇒ fail-closed 按 GRANT_CHANGED，不退回旧口径放行', () => {
    const convId = newConversation('resume-bad-scope')
    const anchor = messageRepo.insert({ conversationId: convId, role: 'user', content: 'q', status: 'done' })
    seedDoneToolStep(convId, anchor)
    assistantRepo.save({ id: assistantId, name: 'a-run-tool-grant', toolPermissions: ['fs.read'] })
    seedInterrupted(convId, 'req-bad-scope', anchor, {
      toolScopeJson: '{"v":2,"mode":"runbook","toolIds":["fs.read"]}',
      toolPermissionsSig: toolPermissionsSignature(['fs.read'])
    })

    expect(chatService.getResumeCandidate(convId)).toEqual(
      expect.objectContaining({ state: 'blocked', code: 'RESUME_TOOL_GRANT_CHANGED' })
    )
  })
})
