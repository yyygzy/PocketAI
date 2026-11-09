// 命令面板跨模块导航总线测试：request/consume pending + 归属过滤（P1 起一律落对话；批次 1 摘除 isAgent 兼容）
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

  it('助手项（无 conversationId）也可发起', () => {
    requestOpenConversation({ assistantId: 'a9' })
    expect(dispatched[1]!.detail).toEqual({ assistantId: 'a9', toolsEnabled: false })
    expect((dispatched[0]!.detail as { moduleId: string }).moduleId).toBe('chat')
  })
})

describe('consumePendingOpenConversation', () => {
  it('读后即清并结构化返回', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a1', toolsEnabled: false }))
    expect(consumePendingOpenConversation()).toEqual({
      conversationId: 'c1',
      assistantId: 'a1',
      toolsEnabled: false
    })
    expect(store.has('pocketai-pending-conv')).toBe(false)
  })

  it('旧结构 isAgent 不再识别（sessionStorage 刷新即清，无需兼容）：清除并返回 null', () => {
    store.set('pocketai-pending-conv', JSON.stringify({ conversationId: 'c1', assistantId: 'a2', isAgent: true }))
    expect(consumePendingOpenConversation()).toBeNull()
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
