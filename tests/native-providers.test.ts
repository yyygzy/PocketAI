// @vitest-environment node
// Anthropic / Gemini 原生适配器回归：真跑 SSE 解析，只桩网络与本地槽位。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/main/providers/local-slot', () => ({
  withLocalSlot: (_req: unknown, fn: () => Promise<unknown>) => fn()
}))

import { AnthropicNativeAdapter } from '../src/main/providers/anthropic-native'
import { GeminiNativeAdapter } from '../src/main/providers/gemini-native'
import type { AdapterChatMessage } from '../src/main/providers/types'

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const messages: AdapterChatMessage[] = [
  { role: 'system', content: '你是代码助手' },
  { role: 'user', content: '读取 a.ts' }
]

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicNativeAdapter', () => {
  it('listModels 用原生 /v1/models 与 x-api-key', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }))
    const adapter = new AnthropicNativeAdapter('https://api.anthropic.com/v1', ['sk-test'])
    expect(await adapter.listModels()).toEqual(['claude-a', 'claude-b'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01')
  })

  it('streamChat 解析 text_delta、tool_use 分块与 cache 用量', async () => {
    const deltas: string[] = []
    const toolDeltas: string[] = []
    fetchMock.mockResolvedValue(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'fs_read' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' }
    ]))
    const adapter = new AnthropicNativeAdapter('https://api.anthropic.com/v1', ['sk-test'])
    const result = await adapter.streamChat(
      messages,
      { model: 'claude-3-5-sonnet', tools: [{ id: 'fs.read', name: 'fs_read', description: '读取', parameters: { type: 'object' }, source: 'builtin', permission: 'auto' }] },
      {
        onDelta: (t) => deltas.push(t),
        onToolCallDelta: (c) => toolDeltas.push(c.function.arguments)
      }
    )
    expect(deltas).toEqual(['你好'])
    expect(result.content).toBe('你好')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls?.[0]).toMatchObject({
      id: 'tu_1',
      function: { name: 'fs_read', arguments: '{"path":"a.ts"}' }
    })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 7, totalTokens: 17, cachedTokens: 4 })
    expect(toolDeltas.at(-1)).toBe('{"path":"a.ts"}')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.model).toBe('claude-3-5-sonnet')
    expect(body.stream).toBe(true)
    expect((body.system as Array<{ cache_control?: unknown }>)[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  it('没有 API Key 时明确报错；embed 不支持', async () => {
    const adapter = new AnthropicNativeAdapter('https://api.anthropic.com/v1', [])
    await expect(adapter.listModels()).rejects.toThrow('未配置 API Key')
    await expect(adapter.embed(['x'], 'claude')).rejects.toThrow('不支持向量化')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GeminiNativeAdapter', () => {
  it('listModels 去掉 models/ 前缀', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.0-flash' }]
    }))
    const adapter = new GeminiNativeAdapter('https://generativelanguage.googleapis.com/v1', ['ga-test'])
    expect(await adapter.listModels()).toEqual(['gemini-2.0-flash', 'gemini-2.5-pro'])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1/models')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('ga-test')
  })

  it('streamChat 解析文本与 functionCall，并汇总 usage', async () => {
    const deltas: string[] = []
    fetchMock.mockResolvedValue(sseResponse([
      {
        candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'FUNCTION_CALL' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, cachedContentTokenCount: 3 }
      },
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'run_tests', args: { files: ['a.test.ts'] } } }] }
        }]
      }
    ]))
    const adapter = new GeminiNativeAdapter('https://generativelanguage.googleapis.com/v1', ['ga-test'])
    const result = await adapter.streamChat(
      messages,
      {
        model: 'gemini-2.5-pro',
        tools: [{ id: 'run_tests', name: 'run_tests', description: '跑测试', parameters: { type: 'object' }, source: 'builtin', permission: 'auto' }]
      },
      { onDelta: (t) => deltas.push(t) }
    )
    expect(deltas).toEqual(['hello'])
    expect(result.content).toBe('hello')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls?.[0]?.function).toEqual({
      name: 'run_tests',
      arguments: '{"files":["a.test.ts"]}'
    })
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 5, totalTokens: 17, cachedTokens: 3 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/models/gemini-2.5-pro:streamGenerateContent?alt=sse')
    expect(url).not.toContain('ga-test')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.systemInstruction).toBeTruthy()
    expect((body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode).toBe('AUTO')
  })

  it('embed 逐条调用 embedContent 并返回向量', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ embedding: { values: [0.1, 0.2] } })))
    const adapter = new GeminiNativeAdapter('https://generativelanguage.googleapis.com/v1', ['ga-test'])
    expect(await adapter.embed(['a', 'b'], 'text-embedding-004')).toEqual([[0.1, 0.2], [0.1, 0.2]])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(':embedContent')
  })
})
