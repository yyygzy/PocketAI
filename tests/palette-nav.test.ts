// 命令面板跨模块导航总线测试：request/consume pending + 归属过滤（isAgent / assistantId）
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
  it('chat 会话：写 pending + 切 chat 模块 + 广播 open 事件', () => {
    requestOpenConversation({ conversationId: 'c1', assistantId: 'a1', isAgent: false })
    expect(JSON.parse(store.get('pocketai-pending-conv')!)).toEqual({
      conversationId: 'c1',
      assistantId: 'a1',
      isAgent: false
    })
    expect(dispatched.map((d) => d.type)).toEqual(['pocketai:switch-module', OPEN_CONVERSATION_EVENT])
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('chat')
  })

  it('agent 会话：切换目标模块为 agent', () => {
    requestOpenConversation({ conversationId: 'c2', assistantId: 'a2', isAgent: true })
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('agent')
  })

  it('助手项（无 conversationId）也可发起', () => {
    requestOpenConversation({ assistantId: 'a9', isAgent: false })
    expect(dispatched[1]!.detail).toEqual({ assistantId: 'a9', isAgent: false })
  })
})

describe('consumePendingOpenConversation', () => {
  it('读后即清并结构化返回', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a1', isAgent: false }))
    expect(consumePendingOpenConversation()).toEqual({ conversationId: 'c1', assistantId: 'a1', isAgent: false })
    expect(store.has('pocketai-pending-conv')).toBe(false)
  })

  it('isAgent 不匹配时保留 pending（chat/agent 互不清）', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', isAgent: true }))
    expect(consumePendingOpenConversation(false)).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(true)
    // agent 侧可正常消费
    expect(consumePendingOpenConversation(true)).toEqual({ conversationId: 'c1', isAgent: true })
  })

  it('assistantId 不匹配时保留 pending（默认助手 effect 防抢消费）', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a2', isAgent: true }))
    expect(consumePendingOpenConversation(true, 'a1')).toBeNull()
    expect(store.has('pocketai-pending-conv')).toBe(true)
    expect(consumePendingOpenConversation(true, 'a2')).toEqual({
      conversationId: 'c1',
      assistantId: 'a2',
      isAgent: true
    })
  })

  it('pending 不带 assistantId 时不参与助手过滤', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', isAgent: false }))
    expect(consumePendingOpenConversation(false, 'a1')).toEqual({ conversationId: 'c1', isAgent: false })
  })

  it('坏 JSON / 缺 isAgent / 两 id 皆无 → 清除并返回 null', () => {
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
