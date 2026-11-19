// @vitest-environment node
// 上下文超长自动恢复（v78 第 3 批）
//
// 目标：云端 400（context_length_exceeded）可被识别，并按"整轮"裁掉最早一段重试；
// 只剩当前一轮时**不裁**——删掉用户的问题本身等于没回答。
import { describe, expect, it } from 'vitest'
import { isContextOverflowError, trimOldestConversationTurn } from '../src/main/agent/context-overflow'
import type { AdapterChatMessage } from '../src/main/providers/types'

describe('isContextOverflowError — 各家文案', () => {
  it('OpenAI / DeepSeek / Qwen / vLLM 的典型报错都识别', () => {
    expect(
      isContextOverflowError(
        'HTTP 400: This model\'s maximum context length is 65536 tokens. However, you requested 70000 tokens'
      )
    ).toBe(true)
    expect(isContextOverflowError('bad request: context window exceeded')).toBe(true)
    expect(isContextOverflowError('prompt is too long: 130000 tokens > 128000 maximum')).toBe(true)
    expect(isContextOverflowError('too many tokens in request')).toBe(true)
  })

  it('不把普通语义误判成超长（如 finish_reason=length / 工具长度）', () => {
    expect(isContextOverflowError('finish_reason=length')).toBe(false)
    expect(isContextOverflowError('tool result length exceeds limit')).toBe(false)
    expect(isContextOverflowError('')).toBe(false)
  })
})

describe('trimOldestConversationTurn', () => {
  const sys: AdapterChatMessage = { role: 'system', content: '系统提示' }

  it('保留 system，删掉最早一整轮（含其中的 tool 消息）', () => {
    const msgs: AdapterChatMessage[] = [
      sys,
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', content: '结果', tool_call_id: 'c1', name: 'x' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' }
    ]
    expect(trimOldestConversationTurn(msgs)).toBe(true)
    expect(msgs[0]).toEqual(sys)
    expect(msgs.map((m) => m.content)).toEqual(['系统提示', '第二问'])
  })

  it('只剩当前一轮 → 不裁（返回 false，数组不变）', () => {
    const msgs: AdapterChatMessage[] = [sys, { role: 'user', content: '唯一的问题' }]
    expect(trimOldestConversationTurn(msgs)).toBe(false)
    expect(msgs).toHaveLength(2)
  })

  it('没有 user 消息 → 不裁', () => {
    const msgs: AdapterChatMessage[] = [sys, { role: 'assistant', content: '你好' }]
    expect(trimOldestConversationTurn(msgs)).toBe(false)
  })
})
