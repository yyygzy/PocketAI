// @vitest-environment node
// 网络层加固（v78 第 2 批）：
//  1) 请求三档超时（首字节 / 流空闲 / 总时长）——超时包装成可重试的 ProviderError，
//     用户主动取消仍原样抛出（否则引擎会把"超时"当成"用户中止"而不重试）；
//  2) `Retry-After` 解析——429 时把服务端点名的等待时长带进错误，引擎才知道该等多久；
//  3) `stream_options` 兼容降级——端点不认该字段时自动去掉重发一次，而不是整轮失败。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAICompatibleAdapter,
  isStreamOptionsUnsupported,
  parseRetryAfterMs
} from '../src/main/providers/openai-compatible'
import { ProviderError } from '../src/main/providers/types'
import type { ToolSchema } from '../src/shared/types'

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('parseRetryAfterMs', () => {
  it('秒数 → 毫秒', () => {
    expect(parseRetryAfterMs('2')).toBe(2000)
    expect(parseRetryAfterMs('0')).toBe(0)
  })

  it('HTTP 日期 → 相对现在的毫秒', () => {
    const now = Date.parse('2026-11-19T00:00:00Z')
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(0)
    const future = new Date(now + 5000).toUTCString()
    expect(parseRetryAfterMs(future, now)).toBe(5000)
  })

  it('空值/非法值 → undefined（不替服务端编一个数）', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('  ')).toBeUndefined()
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined()
  })
})

describe('isStreamOptionsUnsupported', () => {
  it('400 + 报文指向 stream_options → 判定为不认该字段', () => {
    expect(
      isStreamOptionsUnsupported(400, 'Unrecognized request argument supplied: stream_options')
    ).toBe(true)
    expect(isStreamOptionsUnsupported(422, '{"error":"include_usage not supported"}')).toBe(true)
  })

  it('400 + 报文指向 tools → 留给文本协议降级，不在这里吞掉', () => {
    expect(isStreamOptionsUnsupported(400, 'this model does not support tools')).toBe(false)
  })

  it('非 400/422 → 一律不判定（401/429 有自己的路径）', () => {
    expect(isStreamOptionsUnsupported(429, 'stream_options')).toBe(false)
    expect(isStreamOptionsUnsupported(500, 'unknown parameter')).toBe(false)
  })
})

describe('OpenAICompatibleAdapter — stream_options 兼容降级', () => {
  it('首次 400 指向 stream_options → 去掉该字段自动重发，且只降级一次', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"Unrecognized request argument supplied: stream_options"}', {
          status: 400
        })
      )
      .mockResolvedValueOnce(new Response(SSE_OK, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new OpenAICompatibleAdapter('https://api.example.com/v1', ['k'])
    const deltas: string[] = []
    const r = await adapter.streamChat(
      [{ role: 'user', content: 'hi' }],
      { model: 'm' },
      { onDelta: (d) => deltas.push(d) }
    )

    expect(deltas).toEqual(['hi'])
    expect(r.content).toBe('hi')
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
    expect(secondBody).not.toHaveProperty('stream_options')
    expect(secondBody.stream).toBe(true)
  })
})

describe('OpenAICompatibleAdapter — Retry-After 带进错误', () => {
  it('429 + Retry-After: 2 → ProviderError.retryAfterMs=2000 且可重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { 'retry-after': '2' }
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatibleAdapter('https://api.example.com/v1', ['only-key'])

    const err = await adapter
      .streamChat([{ role: 'user', content: 'hi' }], { model: 'm' }, { onDelta: () => {} })
      .then(() => null)
      .catch((e: unknown) => e as ProviderError)

    expect(err).toBeInstanceOf(ProviderError)
    expect(err?.status).toBe(429)
    expect(err?.retryable).toBe(true)
    expect(err?.retryAfterMs).toBe(2000)
  })
})

describe('OpenAICompatibleAdapter — 生成参数映射', () => {
  it('topP/惩罚项/parallel_tool_calls/enable_thinking 都写进请求体', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SSE_OK, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatibleAdapter('https://api.example.com/v1', ['k'])
    const tools: ToolSchema[] = [
      {
        id: 'demo.x',
        name: 'demo_x',
        description: '演示工具',
        parameters: { type: 'object', properties: {} },
        source: 'builtin',
        permission: 'auto'
      }
    ]
    await adapter.streamChat(
      [{ role: 'user', content: 'hi' }],
      {
        model: 'm',
        tools,
        topP: 0.9,
        frequencyPenalty: 0.5,
        presencePenalty: 0.3,
        parallelToolCalls: false,
        enableThinking: false
      },
      { onDelta: () => {} }
    )
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body.top_p).toBe(0.9)
    expect(body.frequency_penalty).toBe(0.5)
    expect(body.presence_penalty).toBe(0.3)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.enable_thinking).toBe(false)
    expect(body.tools).toHaveLength(1)
  })

  it('未提供的参数不写进请求体（不发 undefined 字段）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SSE_OK, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatibleAdapter('https://api.example.com/v1', ['k'])
    await adapter.streamChat([{ role: 'user', content: 'hi' }], { model: 'm' }, { onDelta: () => {} })
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('parallel_tool_calls')
    expect(body).not.toHaveProperty('enable_thinking')
  })
})

describe('OpenAICompatibleAdapter — 首字节超时', () => {
  it('90s 内没有响应 → 抛可重试的「请求超时」而不是 AbortError', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatibleAdapter('https://api.example.com/v1', ['k'])

    const p = adapter
      .streamChat([{ role: 'user', content: 'hi' }], { model: 'm' }, { onDelta: () => {} })
      .then(() => null)
      .catch((e: unknown) => e as ProviderError)

    await vi.advanceTimersByTimeAsync(90_000)
    const err = await p
    expect(err).toBeInstanceOf(ProviderError)
    expect(err?.retryable).toBe(true)
    expect(err?.message).toContain('请求超时')
  })
})
