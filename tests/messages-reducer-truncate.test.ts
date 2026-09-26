// messages-reducer 截断重跑动作测试
import { describe, it, expect } from 'vitest'
import { messagesReducer } from '../src/renderer/src/modules/agent/hooks/messages-reducer'
import type { AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'

const mk = (id: string, role: AgentMessage['role'] = 'user'): AgentMessage => ({ id, role, text: id })

describe('messagesReducer truncateFrom', () => {
  const prev = [mk('u1'), mk('a1', 'assistant'), mk('u2'), mk('a2', 'assistant')]

  it('保留目标之前的消息，移除目标及其后全部卡片', () => {
    expect(messagesReducer(prev, { type: 'truncateFrom', id: 'u2' }).map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('目标不存在时原样返回', () => {
    expect(messagesReducer(prev, { type: 'truncateFrom', id: 'x' })).toBe(prev)
  })

  it('从首条截断得到空数组', () => {
    expect(messagesReducer(prev, { type: 'truncateFrom', id: 'u1' })).toEqual([])
  })
})
