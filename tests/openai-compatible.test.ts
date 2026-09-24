// openai-compatible 消息/工具转换测试
//
// 覆盖 src/main/providers/openai-compatible.ts 的三个纯函数：
// - toOpenAITools：ToolSchema → OpenAI tools 格式
// - toOpenAIMessages：AdapterChatMessage → OpenAI messages 格式（含 tool_calls / tool role）
// - finalizeToolCalls：聚合 Map → ToolCall[]（按 index 排序、空 name+args 跳过、id 兜底）
//
// 策略：三函数均纯函数，模块顶层无重依赖，直接导入测试。
import { describe, it, expect } from 'vitest'
import { toOpenAITools, toOpenAIMessages, finalizeToolCalls } from '../src/main/providers/openai-compatible'
import type { AdapterChatMessage } from '../src/main/providers/types'
import type { ToolSchema } from '../src/shared/types'

// ── toOpenAITools ────────────────────────────────────────
describe('toOpenAITools — ToolSchema → OpenAI tools', () => {
  it('转换为 type:function + function.{name,description,parameters}', () => {
    const tools: ToolSchema[] = [
      {
        name: 'get_weather',
        description: '获取天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
      } as unknown as ToolSchema
    ]
    const result = toOpenAITools(tools)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: '获取天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
      }
    })
  })

  it('空数组 → 空数组', () => {
    expect(toOpenAITools([])).toEqual([])
  })

  it('多工具 → 逐一转换', () => {
    const tools = [
      { name: 'a', description: 'da', parameters: {} },
      { name: 'b', description: 'db', parameters: {} }
    ] as unknown as ToolSchema[]
    const result = toOpenAITools(tools)
    expect(result).toHaveLength(2)
    expect((result[0] as any).function.name).toBe('a')
    expect((result[1] as any).function.name).toBe('b')
  })
})

// ── toOpenAIMessages ─────────────────────────────────────
describe('toOpenAIMessages — AdapterChatMessage → OpenAI messages', () => {
  it('user/system 消息 → {role, content}', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' }
    ]
    const result = toOpenAIMessages(msgs)
    expect(result).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' }
    ])
  })

  it('assistant 无 tool_calls → {role:assistant, content}', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'assistant', content: '回答' }
    ]
    const result = toOpenAIMessages(msgs)
    expect(result[0]).toEqual({ role: 'assistant', content: '回答' })
  })

  it('assistant 有 tool_calls → 转换为 OpenAI tool_calls 格式', () => {
    const msgs: AdapterChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"BJ"}' }
          }
        ]
      }
    ]
    const result = toOpenAIMessages(msgs)
    expect(result[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"BJ"}' }
        }
      ]
    })
  })

  it('assistant 有 tool_calls 且 content 为空串 → content=null', () => {
    const msgs: AdapterChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]
      }
    ]
    const result = toOpenAIMessages(msgs)
    expect((result[0] as any).content).toBeNull()
  })

  it('tool 角色消息 → {role:tool, content, tool_call_id, name}', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'tool', content: '晴', tool_call_id: 'call_1', name: 'get_weather' }
    ]
    const result = toOpenAIMessages(msgs)
    expect(result[0]).toEqual({
      role: 'tool',
      content: '晴',
      tool_call_id: 'call_1',
      name: 'get_weather'
    })
  })

  it('空数组 → 空数组', () => {
    expect(toOpenAIMessages([])).toEqual([])
  })
})

// ── finalizeToolCalls ────────────────────────────────────
describe('finalizeToolCalls — 聚合工具调用整理', () => {
  it('空 Map → undefined', () => {
    expect(finalizeToolCalls(new Map())).toBeUndefined()
  })

  it('按 index 排序输出', () => {
    const map = new Map()
    map.set(1, { index: 1, id: 'c1', name: 'b', arguments: '{}' })
    map.set(0, { index: 0, id: 'c0', name: 'a', arguments: '{}' })
    const result = finalizeToolCalls(map)!
    expect(result).toHaveLength(2)
    expect(result[0]!.function.name).toBe('a')
    expect(result[1]!.function.name).toBe('b')
  })

  it('空 name + 空 arguments → 跳过', () => {
    const map = new Map()
    map.set(0, { index: 0, id: '', name: '', arguments: '' })
    map.set(1, { index: 1, id: 'c1', name: 'a', arguments: '{}' })
    const result = finalizeToolCalls(map)!
    expect(result).toHaveLength(1)
    expect(result[0]!.function.name).toBe('a')
  })

  it('全部空 → undefined', () => {
    const map = new Map()
    map.set(0, { index: 0, id: '', name: '', arguments: '' })
    expect(finalizeToolCalls(map)).toBeUndefined()
  })

  it('id 为空 → 生成兜底 id (call_{index}_{time})', () => {
    const map = new Map()
    map.set(0, { index: 0, id: '', name: 'a', arguments: '{}' })
    const result = finalizeToolCalls(map)!
    expect(result[0]!.id).toMatch(/^call_0_/)
  })

  it('id 非空 → 原样使用', () => {
    const map = new Map()
    map.set(0, { index: 0, id: 'real-id', name: 'a', arguments: '{}' })
    const result = finalizeToolCalls(map)!
    expect(result[0]!.id).toBe('real-id')
  })

  it('arguments 为空 → 兜底 "{}"', () => {
    const map = new Map()
    map.set(0, { index: 0, id: 'c0', name: 'a', arguments: '' })
    const result = finalizeToolCalls(map)!
    expect(result[0]!.function.arguments).toBe('{}')
  })

  it('type 固定为 function', () => {
    const map = new Map()
    map.set(0, { index: 0, id: 'c0', name: 'a', arguments: '{}' })
    const result = finalizeToolCalls(map)!
    expect(result[0]!.type).toBe('function')
  })
})
