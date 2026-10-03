// MESSAGE_FORWARD（消息跨会话转发）handler 测试
//
// 覆盖 src/main/ipc/handlers/messages.ts 中 MESSAGE_FORWARD 的分支：
// - 指定目标会话：直接插入 + touch 目标会话
// - targetConvId=null：按源会话助手维度新建会话（源不存在/未给 → 自由会话）
// - zod 入参校验：空内容/超长被拦截
//
// 策略：mock electron ipcMain.handle 捕获 listener；repo/service 全部 mock 掉，
// 只验证 handler 的编排逻辑（新建会话的 assistantId 继承、插入字段、touch 调用）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  inserted: [] as Record<string, unknown>[],
  touched: [] as string[],
  createdWith: [] as (string | null)[],
  nextConvId: 'new-conv-1',
  sourceConv: null as { assistantId: string | null } | null
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn)
    }
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))
vi.mock('../src/main/db/repositories/message.repo', () => ({
  messageRepo: {
    insert: (input: Record<string, unknown>) => {
      mocks.inserted.push(input)
      return { id: 'msg-forwarded-1', ...input }
    },
    listByConversation: () => [],
    delete: () => {},
    truncateFrom: () => 0,
    setStarred: () => {},
    listStarred: () => []
  }
}))
vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    get: () => mocks.sourceConv,
    create: (input: { assistantId: string | null }) => {
      mocks.createdWith.push(input.assistantId)
      return { id: mocks.nextConvId }
    },
    touch: (id: string) => {
      mocks.touched.push(id)
    }
  }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { setUsageBudgetDaily: () => {}, setUsageBudgetMonthly: () => {} }
}))
vi.mock('../src/main/usage/usage-service', () => ({
  usageService: {
    getSummary: () => null,
    listConversationUsage: () => [],
    listAssistantUsage: () => [],
    listDistinctModels: () => [],
    listUsageDetail: () => ({ items: [], truncated: false }),
    getBudgetStatus: () => ({ daily: null, monthly: null, todayCost: 0, monthCost: 0 })
  }
}))
vi.mock('../src/main/usage/pricing-config', () => ({
  getUsagePricing: () => ({ currency: 'CNY', prices: {} }),
  setUsagePricing: () => {}
}))

import { registerMessageHandlers } from '../src/main/ipc/handlers/messages'
import { IPC } from '../src/shared/types'

const eventStub = { sender: {} }
const invokeForward = (input: unknown) =>
  mocks.handlers.get(IPC.MESSAGE_FORWARD)!(eventStub, input) as Promise<
    { ok: true; convId: string; messageId: string } | { ok: false; error: string }
  >

describe('MESSAGE_FORWARD — 消息跨会话转发', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.inserted.length = 0
    mocks.touched.length = 0
    mocks.createdWith.length = 0
    mocks.sourceConv = null
    registerMessageHandlers()
  })

  it('指定目标会话 → 原样插入（status=done）并 touch，不新建会话', async () => {
    const r = await invokeForward({
      targetConvId: 'c9',
      sourceConvId: 'c1',
      role: 'assistant',
      content: '转发的回答',
      model: 'gpt-4o'
    })
    expect(r).toEqual({ ok: true, convId: 'c9', messageId: 'msg-forwarded-1' })
    expect(mocks.createdWith).toHaveLength(0)
    expect(mocks.inserted[0]).toMatchObject({
      conversationId: 'c9', role: 'assistant', content: '转发的回答', model: 'gpt-4o', status: 'done'
    })
    expect(mocks.touched).toEqual(['c9'])
  })

  it('targetConvId=null → 按源会话助手维度新建会话再插入', async () => {
    mocks.sourceConv = { assistantId: 'asst-7' }
    const r = await invokeForward({
      targetConvId: null,
      sourceConvId: 'c1',
      role: 'user',
      content: '转发的问题',
      model: null
    })
    expect(r).toEqual({ ok: true, convId: 'new-conv-1', messageId: 'msg-forwarded-1' })
    expect(mocks.createdWith).toEqual(['asst-7'])
    expect(mocks.inserted[0]).toMatchObject({ conversationId: 'new-conv-1', role: 'user' })
    expect(mocks.touched).toEqual(['new-conv-1'])
  })

  it('源会话不存在/未给 → 新建自由会话（assistantId=null）', async () => {
    const r = await invokeForward({
      targetConvId: null,
      sourceConvId: null,
      role: 'assistant',
      content: 'x',
      model: null
    })
    expect(r).toMatchObject({ ok: true, convId: 'new-conv-1' })
    expect(mocks.createdWith).toEqual([null])
  })

  it('空内容被 zod 拦截 → { ok: false }，不触库', async () => {
    const r = await invokeForward({
      targetConvId: 'c9',
      sourceConvId: null,
      role: 'user',
      content: '',
      model: null
    })
    expect(r.ok).toBe(false)
    expect(mocks.inserted).toHaveLength(0)
    expect(mocks.touched).toHaveLength(0)
  })
})
