// P4 批次 0：主窗口深链 module=agent
//
// 覆盖三件事（对应验收：命中重定向 / 无候选回退 / 非法参数不崩）：
// · 命中：解析 query 或 hash 里的 module=agent，选最近一条工具会话，产出导航目标；
// · 回退：没有候选（或读失败）时不产出目标 ⇒ 上层按普通启动落到对话页；
// · 非法：module=foo / 空串 / 异常输入一律 null，不抛；
// · 分体窗口：白名单内有 agent 时照旧；摘掉 agent 后旧 `#/detached?module=agent` 回退成对话窗口。
import { describe, expect, it } from 'vitest'
import type { ConversationRecord } from '../src/shared/types'
import {
  consumeBootDeepLinkTarget,
  parseModuleDeepLink,
  pickLatestToolConversation,
  resolveAgentDeepLinkTarget,
  resolveDetachedModuleId,
  setBootDeepLinkTarget
} from '../src/renderer/src/utils/deep-link'

function conv(over: Partial<ConversationRecord>): ConversationRecord {
  return {
    id: 'c1',
    assistantId: 'asst-1',
    title: 't',
    modelLabel: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    titleDefault: true,
    agentMode: false,
    ...over
  }
}

describe('P4 批次 0：深链解析', () => {
  it('query 与 hash-query 都认 module=agent', () => {
    expect(parseModuleDeepLink('?module=agent', '')).toEqual({ module: 'agent' })
    expect(parseModuleDeepLink('', '#/chat?module=agent')).toEqual({ module: 'agent' })
    expect(parseModuleDeepLink('?foo=bar', '#/chat?module=agent')).toEqual({ module: 'agent' })
  })

  it('非法/未知模块与空输入不抛、按普通启动处理', () => {
    expect(parseModuleDeepLink('', '')).toBeNull()
    expect(parseModuleDeepLink('?module=foo', '')).toBeNull()
    expect(parseModuleDeepLink('?module=', '')).toBeNull()
    expect(parseModuleDeepLink('?module=AGENT', '')).toBeNull()
  })

  it('分体窗口：白名单内有 agent 照旧；摘掉后旧链接回退成对话窗口', () => {
    expect(resolveDetachedModuleId('#/detached?module=agent', ['chat', 'agent'])).toBe('agent')
    expect(resolveDetachedModuleId('#/detached?module=agent', ['chat', 'skills'])).toBe('chat')
    expect(resolveDetachedModuleId('#/detached?module=foo', ['chat', 'skills'])).toBe('chat')
    expect(resolveDetachedModuleId('#/detached', ['chat'])).toBe('chat')
    expect(resolveDetachedModuleId('#/chat', ['chat'])).toBeNull()
  })
})

describe('P4 批次 0：最近一条工具会话口径', () => {
  it('只看 agent_mode=1 且未归档，按 updatedAt 降序，置顶不参与', () => {
    const pinnedOld = conv({ id: 'pinned-old', agentMode: true, pinned: true, updatedAt: 10 })
    const recent = conv({ id: 'recent', agentMode: true, updatedAt: 30 })
    const plain = conv({ id: 'plain', agentMode: false, updatedAt: 50 })
    const archived = conv({ id: 'archived', agentMode: true, archived: true, updatedAt: 60 })
    expect(pickLatestToolConversation([pinnedOld, recent, plain, archived])?.id).toBe('recent')
  })

  it('同刻按 createdAt 降序；空列表返回 null', () => {
    const a = conv({ id: 'a', agentMode: true, updatedAt: 20, createdAt: 5 })
    const b = conv({ id: 'b', agentMode: true, updatedAt: 20, createdAt: 9 })
    expect(pickLatestToolConversation([a, b])?.id).toBe('b')
    expect(pickLatestToolConversation([])).toBeNull()
    expect(pickLatestToolConversation([conv({ id: 'plain' })])).toBeNull()
  })
})

describe('P4 批次 0：深链目标解析', () => {
  it('命中：产出带会话与助手 id 的对话跳转（toolsEnabled=true）', async () => {
    const list = [
      conv({ id: 'old', agentMode: true, updatedAt: 10 }),
      conv({ id: 'new', assistantId: 'asst-2', agentMode: true, updatedAt: 40 })
    ]
    const target = await resolveAgentDeepLinkTarget(async () => list)
    expect(target).toEqual({ conversationId: 'new', assistantId: 'asst-2', toolsEnabled: true })
  })

  it('无候选回退：没有工具会话 ⇒ null（上层落对话页默认选中）', async () => {
    expect(await resolveAgentDeepLinkTarget(async () => [conv({ id: 'plain' })])).toBeNull()
    expect(await resolveAgentDeepLinkTarget(async () => [] as ConversationRecord[])).toBeNull()
  })

  it('读失败/异常不崩：返回 null', async () => {
    expect(
      await resolveAgentDeepLinkTarget(async () => ({ ok: false, error: 'db down' }))
    ).toBeNull()
    expect(await resolveAgentDeepLinkTarget(async () => { throw new Error('boom') })).toBeNull()
  })

  it('启动目标只消费一次（避免 App 重挂后重复跳转）', () => {
    const target = { conversationId: 'c1', assistantId: 'a1', toolsEnabled: true }
    setBootDeepLinkTarget(target)
    expect(consumeBootDeepLinkTarget()).toEqual(target)
    expect(consumeBootDeepLinkTarget()).toBeNull()
  })
})
