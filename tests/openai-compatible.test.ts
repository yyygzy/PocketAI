// openai-compatible 消息/工具转换测试
//
// 覆盖 src/main/providers/openai-compatible.ts 的四个纯函数：
// - toOpenAITools：ToolSchema → OpenAI tools 格式
// - toOpenAIMessages：AdapterChatMessage → OpenAI messages 格式（含 tool_calls / tool role / promptCache 断点）
// - finalizeToolCalls：聚合 Map → ToolCall[]（按 index 排序、空 name+args 跳过、id 兜底）
// - parseUsage：流式 usage 解析（含 Anthropic/OpenAI 两种缓存命中字段）
//
// 策略：均为纯函数，模块顶层无重依赖，直接导入测试。
import { describe, it, expect } from 'vitest'
import { toOpenAITools, toOpenAIMessages, finalizeToolCalls, parseUsage } from '../src/main/providers/openai-compatible'
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

// ── toOpenAIMessages — promptCache（Anthropic cache_control 断点）───
describe('toOpenAIMessages — promptCache 断点', () => {
  const CC = { type: 'ephemeral' }

  it('默认 false → system/user 保持字符串（与原行为一致）', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' }
    ]
    expect(toOpenAIMessages(msgs)).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' }
    ])
  })

  it('promptCache=true → system 转为带 cache_control 的 content blocks', () => {
    const msgs: AdapterChatMessage[] = [{ role: 'system', content: '你是助手' }]
    const result = toOpenAIMessages(msgs, true)
    expect(result[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: '你是助手', cache_control: CC }]
    })
  })

  it('只给最后一条 user 打断点，早期 user 不打', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' }
    ]
    const result = toOpenAIMessages(msgs, true)
    expect((result[0] as any).content).toBe('第一问')
    expect((result[1] as any).content).toBe('第一答')
    expect((result[2] as any).content).toEqual([{ type: 'text', text: '第二问', cache_control: CC }])
  })

  it('assistant(tool_calls) 与 tool 消息不受影响', () => {
    const msgs: AdapterChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]
      },
      { role: 'tool', content: '结果', tool_call_id: 'c1', name: 'a' }
    ]
    const result = toOpenAIMessages(msgs, true)
    expect((result[0] as any).content).toBeNull()
    expect(result[1]).toEqual({ role: 'tool', content: '结果', tool_call_id: 'c1', name: 'a' })
  })

  it('多模态数组内容：最后一个 part 打标记，原数组不被修改', () => {
    const parts: AdapterChatMessage['content'] = [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }
    ]
    const snapshot = JSON.stringify(parts)
    const msgs: AdapterChatMessage[] = [{ role: 'user', content: parts }]
    const result = toOpenAIMessages(msgs, true)
    const out = (result[0] as any).content as Array<Record<string, unknown>>
    expect(out).toHaveLength(2)
    expect(out[0]!.cache_control).toBeUndefined()
    expect(out[1]!.cache_control).toEqual(CC)
    expect(out[1]!.image_url).toEqual({ url: 'data:image/png;base64,xxx' })
    expect(JSON.stringify(parts)).toBe(snapshot) // 输入未被突变
  })

  it('空字符串 content 不打标记（无效块会被 Anthropic 拒绝）', () => {
    const msgs: AdapterChatMessage[] = [{ role: 'user', content: '' }]
    expect(toOpenAIMessages(msgs, true)).toEqual([{ role: 'user', content: '' }])
  })

  it('无 system 且无 user（只有 assistant/tool）→ 原样输出', () => {
    const msgs: AdapterChatMessage[] = [
      { role: 'assistant', content: '回答' },
      { role: 'tool', content: 'r', tool_call_id: 'c1' }
    ]
    expect(toOpenAIMessages(msgs, true)).toEqual([
      { role: 'assistant', content: '回答' },
      { role: 'tool', content: 'r', tool_call_id: 'c1' }
    ])
  })
})

// ── parseUsage ───────────────────────────────────────────
describe('parseUsage — 流式 usage 解析', () => {
  it('基础字段：缺失的 prompt/completion 按 0 兜底', () => {
    expect(parseUsage({ total_tokens: 100 })).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 100
    })
  })

  it('Anthropic 风格 cache_read_input_tokens → cachedTokens', () => {
    expect(parseUsage({ total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, cache_read_input_tokens: 60 })).toEqual({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cachedTokens: 60
    })
  })

  it('OpenAI 风格 prompt_tokens_details.cached_tokens → cachedTokens', () => {
    expect(
      parseUsage({ total_tokens: 100, prompt_tokens_details: { cached_tokens: 64 } })!.cachedTokens
    ).toBe(64)
  })

  it('无缓存字段 → 无 cachedTokens 键', () => {
    expect(parseUsage({ total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 })).not.toHaveProperty('cachedTokens')
  })

  it('total_tokens 缺失或非对象 → undefined', () => {
    expect(parseUsage({ prompt_tokens: 80 })).toBeUndefined()
    expect(parseUsage(null)).toBeUndefined()
    expect(parseUsage('usage')).toBeUndefined()
  })

  it('prompt_tokens_details 为 null 时不抛错', () => {
    expect(parseUsage({ total_tokens: 10, prompt_tokens_details: null })!.cachedTokens).toBeUndefined()
  })
})
