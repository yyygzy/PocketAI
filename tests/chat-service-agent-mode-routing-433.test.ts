// V4-Iter-433（P0-4 v1 动态路由面）：chat:send 的 agentMode 真假必须实时分叉
//
// 为什么不再"看代码分支"：`chat-service.send` 里 agentMode=true 直接 return 委托 `AgentEngine.run`，
// false/省略则继续走 provider 适配器的普通对话路径。两条路对外的副作用完全不同（是否建 assistant
// 占位、是否发 CHAT_DONE），只读源码无法证明现在的行为。
//
// 这里复用 `tests/chat-service-prompt-override.test.ts` 的既有 mock 基础设施（轻量 vi.mock，
// 不引入新依赖、不另起 mock 框架），只额外记录两件事：AgentEngine.run 被谁调用、provider 适配器
// 的 streamChat 有没有被拉起。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  runCalls: [] as Array<Record<string, unknown>>,
  adapterCalls: 0,
  insertRows: [] as Array<Record<string, unknown>>,
  updateContents: [] as Array<{ id: string; status: string }>,
  emitted: [] as string[]
}))

vi.mock('../src/main/db/repositories/message.repo', () => ({
  messageRepo: {
    insert: (row: Record<string, unknown>) => {
      state.insertRows.push(row)
      return { id: row.role === 'user' ? 'm-user' : 'm-assistant' }
    },
    listByConversation: () => [{ id: 'm-user', role: 'user', content: '你好', createdAt: 1 }],
    updateContent: (id: string, _content: string, status: string) => {
      state.updateContents.push({ id, status })
    },
    updateUserContent: () => {}
  }
}))
vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    get: () => ({ id: 'c1', systemPromptOverride: null }),
    touch: () => {}
  }
}))
vi.mock('../src/main/db/repositories/assistant.repo', () => ({
  assistantRepo: {
    get: () => ({ id: 'a1', systemPrompt: '', knowledgeBaseIds: [], skillIds: [] })
  }
}))
vi.mock('../src/main/conversation/title-gen', () => ({ runFirstMessageTitle: () => {} }))
vi.mock('../src/main/assistant/prompt-template', () => ({ renderPrompt: (tpl: string) => tpl }))
vi.mock('../src/main/assistant/skills', () => ({ buildSkillsContext: () => '' }))
vi.mock('../src/main/knowledge/rag', () => ({
  ragService: { retrieve: async () => ({ chunks: [] }), buildContext: () => '' }
}))
vi.mock('../src/main/knowledge/retrieval-degrade', () => ({ noteRetrievalDegradation: () => {} }))
vi.mock('../src/shared/kb-sources', () => ({ chunksToSources: () => [] }))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => {
      state.adapterCalls += 1
      return {
        streamChat: async (
          _messages: unknown,
          _opts: unknown,
          hooks: { onDelta?: (d: string) => void }
        ) => {
          hooks.onDelta?.('普通回答')
          return { content: '普通回答', usage: {} }
        }
      }
    }
  }
}))
vi.mock('../src/main/keep-awake', () => ({ acquireKeepAwake: () => {}, releaseKeepAwake: () => {} }))
vi.mock('../src/main/chat/concurrency', () => ({
  withProviderLimit: (_p: unknown, fn: () => unknown) => fn()
}))
vi.mock('../src/main/agent/engine', () => ({
  agentEngine: {
    abort: () => {},
    run: async (payload: Record<string, unknown>) => {
      state.runCalls.push(payload)
    }
  }
}))
vi.mock('../src/main/error', () => ({ errMsg: (e: unknown) => String(e), isAbortError: () => false }))
vi.mock('../src/main/usage/usage-service', () => ({ usageService: { checkBudgetExceeded: () => null } }))
vi.mock('../src/main/usage/pricing-config', () => ({
  getUsagePricing: () => ({ prices: {} as Record<string, unknown> })
}))
vi.mock('../src/main/usage/budget-warn', () => ({ checkAndBroadcastBudgetWarnings: () => {} }))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { isUsageBudgetHardBlockEnabled: () => false }
}))
vi.mock('../src/main/db/repositories/kb.repo', () => ({ kbRepo: { get: () => null } }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../src/main/steward/perf-probe', () => ({
  recordChatStreamPerf: () => {},
  logPerfDebug: () => {}
}))

import { chatService } from '../src/main/chat/chat-service'
import { IPC } from '../src/shared/types'

const basePayload = () => ({
  requestId: 'r1',
  conversationId: 'c1',
  assistantId: 'a1',
  content: '你好',
  targets: [{ providerId: 'p1', model: 'm1' }]
})

const emit = (channel: string) => {
  state.emitted.push(channel)
}

beforeEach(() => {
  state.runCalls.length = 0
  state.adapterCalls = 0
  state.insertRows.length = 0
  state.updateContents.length = 0
  state.emitted.length = 0
})

describe('chat:send agentMode 动态路由', () => {
  it('agentMode:true ⇒ 真委托 AgentEngine.run，且不启动普通 provider 路径', async () => {
    const payload = basePayload()
    await chatService.send({ ...payload, agentMode: true }, emit)

    expect(state.runCalls, 'agentMode=true 必须进 AgentEngine').toHaveLength(1)
    expect(state.runCalls[0]).toMatchObject({ requestId: 'r1', conversationId: 'c1', agentMode: true })
    expect(state.adapterCalls, 'Agent 模式下不许再拉普通适配器').toBe(0)
    expect(state.insertRows, 'Agent 路径自己不建占位，交给引擎').toHaveLength(0)
    expect(state.emitted).not.toContain(IPC.CHAT_DONE_EVENT)
  })

  it('agentMode:false ⇒ 走普通对话路径，不进 AgentEngine', async () => {
    const payload = basePayload()
    await chatService.send({ ...payload, agentMode: false }, emit)

    expect(state.runCalls, '显式 false 不许进 AgentEngine').toHaveLength(0)
    expect(state.adapterCalls, '普通路径必须拉起适配器').toBe(1)
    expect(state.insertRows.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(state.updateContents).toContainEqual({ id: 'm-assistant', status: 'done' })
    expect(state.emitted).toContain(IPC.CHAT_DONE_EVENT)
  })

  it('省略 agentMode ⇒ 同样走普通对话路径（缺省不升级为 Agent）', async () => {
    await chatService.send(basePayload(), emit)

    expect(state.runCalls, '省略字段必须等价 false').toHaveLength(0)
    expect(state.adapterCalls).toBe(1)
    expect(state.updateContents).toContainEqual({ id: 'm-assistant', status: 'done' })
    expect(state.emitted).toContain(IPC.CHAT_DONE_EVENT)
  })
})
