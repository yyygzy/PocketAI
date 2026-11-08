// 命令面板跨模块导航总线测试：request/consume pending + 归属过滤（P1：一律落对话，isAgent 仅读兼容）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
})

const dispatched: { type: string; detail?: unknown }[] = []
vi.stubGlobal('window', {
  dispatchEvent: (e: CustomEvent) => void dispatched.push({ type: e.type, detail: e.detail })
})

import {
  requestOpenConversation,
  consumePendingOpenConversation,
  requestOpenKb,
  consumePendingKb,
  OPEN_CONVERSATION_EVENT,
  OPEN_KB_EVENT
} from '../src/renderer/src/utils/palette-nav'

beforeEach(() => {
  store.clear()
  dispatched.length = 0
})

describe('requestOpenConversation', () => {
  it('会话项：写新结构 pending + 切 chat 模块 + 广播 open 事件', () => {
    requestOpenConversation({ conversationId: 'c1', assistantId: 'a1', toolsEnabled: false })
    expect(JSON.parse(store.get('pocketai-pending-conv')!)).toEqual({
      conversationId: 'c1',
      assistantId: 'a1',
      toolsEnabled: false
    })
    expect(dispatched.map((d) => d.type)).toEqual(['pocketai:switch-module', OPEN_CONVERSATION_EVENT])
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('chat')
  })

  it('旧结构调用（isAgent:true）也一律落对话，只保留 isAgent 供过渡壳读取', () => {
    requestOpenConversation({ conversationId: 'c2', assistantId: 'a2', isAgent: true })
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('chat')
    expect(JSON.parse(store.get('pocketai-pending-conv')!)).toEqual({
      conversationId: 'c2',
      assistantId: 'a2',
      toolsEnabled: true,
      isAgent: true
    })
  })

  it('助手项（无 conversationId）也可发起', () => {
    requestOpenConversation({ assistantId: 'a9' })
    expect(dispatched[1]!.detail).toEqual({ assistantId: 'a9', toolsEnabled: false })
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('chat')
  })
})

describe('consumePendingOpenConversation', () => {
  it('读后即清并结构化返回（isAgent 翻译为 toolsEnabled）', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a1', toolsEnabled: false }))
    expect(consumePendingOpenConversation()).toEqual({
      conversationId: 'c1',
      assistantId: 'a1',
      toolsEnabled: false
    })
    expect(store.has('pocketai-pending-conv')).toBe(false)
  })

  it('旧结构 isAgent:true → toolsEnabled:true（落对话页，不再落 Agent 模块）', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a2', isAgent: true }))
    expect(consumePendingOpenConversation()).toEqual({
      conversationId: 'c1',
      assistantId: 'a2',
      toolsEnabled: true
    })
    expect(store.has('pocketai-pending-conv')).toBe(false)
  })

  it('assistantId 不匹配时保留 pending（默认助手 effect 防抢消费）', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a2', toolsEnabled: true }))
    expect(consumePendingOpenConversation({ assistantId: 'a1' })).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(true)
    expect(consumePendingOpenConversation({ assistantId: 'a2' })).toEqual({
      conversationId: 'c1',
      assistantId: 'a2',
      toolsEnabled: true
    })
  })

  it('pending 不带 assistantId 时不参与助手过滤', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', toolsEnabled: false }))
    expect(consumePendingOpenConversation({ assistantId: 'a1' })).toEqual({
      conversationId: 'c1',
      toolsEnabled: false
    })
  })

  it('legacyAgentOnly：新结构原样保留给对话，旧 isAgent:true 才消费', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', toolsEnabled: true }))
    expect(consumePendingOpenConversation({ legacyAgentOnly: true })).toBeNull()
    expect(store.has('pocketai-pending-conv'), '不能被 Agent 壳偷走').toBe(true)
    expect(consumePendingOpenConversation()).toEqual({ conversationId: 'c1', toolsEnabled: true })

    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c2', isAgent: true }))
    expect(consumePendingOpenConversation({ legacyAgentOnly: true })).toEqual({
      conversationId: 'c2',
      toolsEnabled: true
    })
  })

  it('助手项（只有 assistantId）不需要能力口径', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ assistantId: 'a1' }))
    expect(consumePendingOpenConversation()).toEqual({ assistantId: 'a1', toolsEnabled: false })
  })

  it('坏 JSON / 会话项缺能力口径 / 两 id 皆无 → 清除并返回 null', () => {
    store.set('pocketai-pending-conv', '{bad')
    expect(consumePendingOpenConversation()).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(false)

    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1' }))
    expect(consumePendingOpenConversation()).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(false)

    store.set('pocketai-pending-conv', JSON.stringify({ isAgent: false }))
    expect(consumePendingOpenConversation()).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(false)
  })

  it('无 pending 返回 null', () => {
    expect(consumePendingOpenConversation()).toBeNull()
  })
})

describe('requestOpenKb / consumePendingKb', () => {
  it('发起：写 pending + 切 knowledge 模块 + 广播', () => {
    requestOpenKb('kb1')
    expect(store.get('pocketai-pending-kb')).toBe(JSON.stringify('kb1'))
    expect(dispatched.map((d) => d.type)).toEqual(['pocketai:switch-module', OPEN_KB_EVENT])
    expect(dispatched[1]!.detail).toEqual({ kbId: 'kb1' })
  })

  it('消费：读后即清；空串/坏 JSON/null 返回 null', () => {
    store.set('pocketai-pending-kb', JSON.stringify('kb2'))
    expect(consumePendingKb()).toBe('kb2')
    expect(consumePendingKb()).toBeNull()

    store.set('pocketai-pending-kb', JSON.stringify(''))
    expect(consumePendingKb()).toBeNull()
    store.set('pocketai-pending-kb', '{bad')
    expect(consumePendingKb()).toBeNull()
  })
})
