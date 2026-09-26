// findRerunSourceId 纯函数测试：「重新生成」定位前序可重跑用户消息
import { describe, it, expect } from 'vitest'
import { findRerunSourceId, type AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

function user(id: string, text = '你好', dbId?: string): AgentMessage {
  return { id, role: 'user', text, dbId }
}
function assistant(id: string, text = '', isFinal = false): AgentMessage {
  return { id, role: 'assistant', text, isFinal }
}
function tool(id: string): AgentMessage {
  return { id, role: 'tool', text: '' }
}

describe('findRerunSourceId', () => {
  it('助手卡之前最近的用户卡（有 dbId）', () => {
    const msgs = [user('u1', '第一条', 'db1'), assistant('a1', '回复', true)]
    expect(findRerunSourceId(msgs, 'a1')).toBe('u1')
  })

  it('中间隔着工具卡：跳过工具卡找到用户卡', () => {
    const msgs = [user('u1', 'x', 'db1'), tool('t1'), tool('t2'), assistant('a1', 'final', true)]
    expect(findRerunSourceId(msgs, 'a1')).toBe('u1')
  })

  it('多轮对话：只取目标助手之前最近一轮的用户消息', () => {
    const msgs = [
      user('u1', '第一轮', 'db1'),
      assistant('a0', 'r1', true),
      user('u2', '第二轮', 'db2'),
      assistant('a1', 'r2', true)
    ]
    expect(findRerunSourceId(msgs, 'a1')).toBe('u2')
    expect(findRerunSourceId(msgs, 'a0')).toBe('u1')
  })

  it('前面的用户卡无 dbId（运行中占位卡）→ 跳过继续找更早的已持久化卡', () => {
    const msgs = [user('u0', '老消息', 'db0'), user('u1', '占位'), assistant('a1', 'x', true)]
    expect(findRerunSourceId(msgs, 'a1')).toBe('u0')
  })

  it('用户卡文本全空白 → 不可重跑，跳过', () => {
    const msgs = [user('u0', '正常', 'db0'), user('u1', '   ', 'db1'), assistant('a1', 'x', true)]
    expect(findRerunSourceId(msgs, 'a1')).toBe('u0')
  })

  it('目标是第一条消息 / 找不到 / 不存在的 id → null', () => {
    const msgs = [assistant('a0', 'x', true)]
    expect(findRerunSourceId(msgs, 'a0')).toBeNull()
    expect(findRerunSourceId([user('u1', 'x', 'db1')], 'u1')).toBeNull()
    expect(findRerunSourceId(msgs, 'nope')).toBeNull()
  })

  it('前面没有任何可重跑用户卡 → null', () => {
    const msgs = [tool('t1'), assistant('a1', 'x', true)]
    expect(findRerunSourceId(msgs, 'a1')).toBeNull()
  })
})
