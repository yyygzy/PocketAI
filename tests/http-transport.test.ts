// MCP Streamable HTTP transport 测试
//
// 覆盖 src/main/mcp/http-transport.ts：
//  - parseSseStream：事件切分、跨 chunk、多 data 行、字节上限（防无界累积 DoS）
//  - readBoundedBody：有界读取、超限拒绝
//  - HttpJsonRpcClient：JSON/SSE 两种响应形态、session id、超时、notify、shutdown
//
// 策略：用真实 Response/ReadableStream（构造可控），仅 mock 全局 fetch，
// 使流解析与有界读取走真实代码路径。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  HttpJsonRpcClient,
  parseSseStream,
  readBoundedBody,
  DEFAULT_MAX_BYTES
} from '../src/main/mcp/http-transport'
import {
  McpBusinessError,
  McpTransportError,
  type JsonRpcNotification
} from '../src/main/mcp/json-rpc'

const URL = 'https://example.com/mcp'
const encoder = new TextEncoder()

// ---------- 构造工具 ----------

/** 由多段数据构造 ReadableStream（字符串自动 UTF-8 编码） */
function streamFrom(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? encoder.encode(c) : c)
      }
      controller.close()
    }
  })
}

/** 收集 parseSseStream 的全部事件 */
async function collectSse(
  chunks: Array<string | Uint8Array>,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<Array<{ event: string; data: string }>> {
  const out: Array<{ event: string; data: string }> = []
  for await (const evt of parseSseStream(streamFrom(chunks), maxBytes)) {
    out.push(evt)
  }
  return out
}

/** 构造 Response；body 为字符串时作为真实可读流 */
function makeResponse(opts: {
  contentType?: string
  body?: string | null
  headers?: Record<string, string>
}): Response {
  const { contentType = 'application/json', body = null, headers = {} } = opts
  return new Response(body, {
    headers: { 'content-type': contentType, ...headers }
  })
}

/** JSON-RPC 响应体字符串 */
function rpcResult(result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result })
}
function rpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message } })
}

// ---------- fetch mock ----------

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- parseSseStream ----------

describe('parseSseStream — 事件解析', () => {
  it('单 chunk 多个事件：按 \\n\\n 切分，解析 event/data', async () => {
    const events = await collectSse([
      'event: result\ndata: {"a":1}\n\nevent: notification\ndata: {"b":2}\n\n'
    ])
    expect(events).toEqual([
      { event: 'result', data: '{"a":1}' },
      { event: 'notification', data: '{"b":2}' }
    ])
  })

  it('跨 chunk 切分：事件边界与字段可分散在不同 chunk', async () => {
    const events = await collectSse(['event: re', 'sult\nda', 'ta: {"x":1}\n\n'])
    expect(events).toEqual([{ event: 'result', data: '{"x":1}' }])
  })

  it('多条 data 行按 \\n 拼接；event 缺省为 message', async () => {
    const events = await collectSse(['data: line1\ndata: line2\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }])
  })

  it('comment（: 开头）与未知字段忽略', async () => {
    const events = await collectSse([': keep-alive\nid: 42\ndata: hello\n\n'])
    expect(events).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('流结束时尾部不完整事件忽略', async () => {
    const events = await collectSse(['data: first\n\n', 'data: incomplete'])
    expect(events).toEqual([{ event: 'message', data: 'first' }])
  })
})

describe('parseSseStream — 字节上限（防无界累积）', () => {
  it('分隔符到达前累积超限 → 抛错且不回显内容', async () => {
    const stream = streamFrom(['x'.repeat(100)])
    await expect(async () => {
      for await (const _ of parseSseStream(stream, 50)) {
        // 不应产出任何事件
      }
    }).rejects.toThrow(/SSE 事件超过 50 字节上限/)
  })

  it('恰达上限（含分隔符字节）→ 正常产出事件', async () => {
    // data 行 50 字节（"data: " 6 + 内容 44）+ 2 字节 \n\n = 52，给 maxBytes=52
    const line = 'data: ' + 'x'.repeat(44)
    const events = await collectSse([line + '\n\n'], 52)
    expect(events).toEqual([{ event: 'message', data: 'x'.repeat(44) }])
  })

  it('超限仅作用于当前事件：超限前已切分的事件不受影响', async () => {
    // 先产出一个合法事件，随后无分隔符巨流
    const stream = streamFrom(['data: ok\n\n', 'y'.repeat(100)])
    const iterator = parseSseStream(stream, 50)
    const first = await iterator.next()
    expect(first.value).toEqual({ event: 'message', data: 'ok' })
    await expect(iterator.next()).rejects.toThrow(/SSE 事件超过 50 字节上限/)
  })
})

// ---------- readBoundedBody ----------

describe('readBoundedBody', () => {
  it('正常读取整个响应体', async () => {
    const text = await readBoundedBody(makeResponse({ body: 'hello world' }), DEFAULT_MAX_BYTES)
    expect(text).toBe('hello world')
  })

  it('无 body → 返回空串', async () => {
    expect(await readBoundedBody(makeResponse({ body: null }), DEFAULT_MAX_BYTES)).toBe('')
  })

  it('累积超限 → 抛错拒绝（防 res.text() 内存耗尽）', async () => {
    await expect(
      readBoundedBody(makeResponse({ body: 'x'.repeat(100) }), 50)
    ).rejects.toThrow(/响应体超过 50 字节上限/)
  })
})

// ---------- HttpJsonRpcClient.request ----------

describe('HttpJsonRpcClient — request', () => {
  it('JSON 响应：返回 result，POST 禁跟重定向', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: rpcResult({ ok: true }) }))
    const client = new HttpJsonRpcClient({ url: URL })
    const result = await client.request<{ ok: boolean }>('tools/list')
    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ method: 'POST', redirect: 'error' })
    )
  })

  it('JSON 错误响应：throw McpBusinessError 携带 message 与 code', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: rpcError(-32600, 'bad request') }))
    const client = new HttpJsonRpcClient({ url: URL })
    const err = await client.request('ping').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(McpBusinessError)
    expect((err as McpBusinessError).code).toBe(-32600)
    expect((err as Error).message).toBe('bad request (code=-32600)')
  })

  it('fetch 网络失败 → McpTransportError(network)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { name: 'TypeError' }))
    const client = new HttpJsonRpcClient({ url: URL })
    const err = await client.request('ping').then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(McpTransportError)
    expect((err as McpTransportError).kind).toBe('network')
    expect((err as Error).message).toBe('fetch failed')
  })

  it('SSE 响应：从 event: result 取结果', async () => {
    const sse = `event: result\ndata: ${rpcResult({ v: 1 })}\n\n`
    fetchMock.mockResolvedValue(makeResponse({ contentType: 'text/event-stream', body: sse }))
    const client = new HttpJsonRpcClient({ url: URL })
    expect(await client.request('tools/list')).toEqual({ v: 1 })
  })

  it('SSE notification 事件经 onNotification 转发，不影响 result', async () => {
    const notif = { jsonrpc: '2.0', method: 'progress', params: { p: 50 } }
    const sse =
      `event: notification\ndata: ${JSON.stringify(notif)}\n\n` +
      `event: result\ndata: ${rpcResult('done')}\n\n`
    fetchMock.mockResolvedValue(makeResponse({ contentType: 'text/event-stream', body: sse }))
    const client = new HttpJsonRpcClient({ url: URL })
    const received: JsonRpcNotification[] = []
    client.onNotification((n) => received.push(n))
    expect(await client.request('long/job')).toBe('done')
    expect(received).toEqual([notif])
  })

  it('SSE 流结束无 result → throw', async () => {
    const sse = `event: endpoint\ndata: /x\n\n`
    fetchMock.mockResolvedValue(makeResponse({ contentType: 'text/event-stream', body: sse }))
    const client = new HttpJsonRpcClient({ url: URL })
    await expect(client.request('ping')).rejects.toThrow('SSE 流结束未收到 result 事件')
  })

  it('未知 Content-Type 且非 JSON 体 → throw 不支持的 Content-Type', async () => {
    fetchMock.mockResolvedValue(makeResponse({ contentType: 'text/plain', body: 'hello' }))
    const client = new HttpJsonRpcClient({ url: URL })
    await expect(client.request('ping')).rejects.toThrow(/不支持的响应 Content-Type/)
  })

  it('initialize 响应的 Mcp-Session-Id 被保存并在后续请求携带', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse({ body: rpcResult({}), headers: { 'Mcp-Session-Id': 'sess-abc' } })
    )
    fetchMock.mockResolvedValueOnce(makeResponse({ body: rpcResult({ next: true }) }))
    const client = new HttpJsonRpcClient({ url: URL })
    await client.request('initialize')
    await client.request('tools/list')
    const secondCall = fetchMock.mock.calls[1]!
    const init = secondCall[1] as { headers: Record<string, string> }
    expect(init.headers['Mcp-Session-Id']).toBe('sess-abc')
  })

  it('超时：fetch 挂起超过指定时长 → throw JSON-RPC 请求超时', async () => {
    // mock 与真实 fetch 一样响应 abort 信号
    fetchMock.mockImplementation((_u: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })
    const client = new HttpJsonRpcClient({ url: URL })
    const err = await client.request('ping', undefined, 100).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(McpTransportError)
    expect((err as McpTransportError).kind).toBe('timeout')
    expect((err as Error).message).toBe('JSON-RPC 请求超时: ping (100ms)')
  })

  it('通道关闭后 request → reject', async () => {
    // shutdown 的协议请求也需要一个 fetch 响应
    fetchMock.mockResolvedValue(makeResponse({ body: rpcResult(null) }))
    const client = new HttpJsonRpcClient({ url: URL })
    await client.shutdown()
    await expect(client.request('ping')).rejects.toThrow('HTTP 传输通道已关闭')
  })
})

// ---------- notify ----------

describe('HttpJsonRpcClient — 自定义请求头', () => {
  it('options.headers 注入 request 与 notify（如 Authorization）', async () => {
    // 每次调用返回全新 Response，避免 body 被重复消费
    fetchMock.mockImplementation(() => Promise.resolve(makeResponse({ body: rpcResult({ ok: true }) })))
    const client = new HttpJsonRpcClient({
      url: URL,
      headers: { Authorization: 'Bearer tok', 'X-Tenant': 'acme' }
    })
    await client.request('ping')
    client.notify('notifications/initialized')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers: Record<string, string> }).headers
      expect(headers.Authorization).toBe('Bearer tok')
      expect(headers['X-Tenant']).toBe('acme')
    }
  })

  it('协议头后写优先：用户头不可覆盖 Content-Type/Accept', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(makeResponse({ body: rpcResult({}) })))
    const client = new HttpJsonRpcClient({
      url: URL,
      headers: { 'Content-Type': 'text/plain', Accept: 'application/xml' }
    })
    await client.request('ping')
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('未传 headers → 行为与既有默认一致（仅协议头）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(makeResponse({ body: rpcResult({}) })))
    const client = new HttpJsonRpcClient({ url: URL })
    await client.request('ping')
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers
    expect(headers).toEqual({ 'Content-Type': 'application/json', Accept: 'text/event-stream' })
  })
})

describe('HttpJsonRpcClient — notify', () => {
  it('notify 立即 POST 无 id 通知', () => {
    fetchMock.mockResolvedValue(makeResponse({ body: null }))
    const client = new HttpJsonRpcClient({ url: URL })
    client.notify('notifications/initialized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>
    expect(body.method).toBe('notifications/initialized')
    expect(body).not.toHaveProperty('id')
  })

  it('关闭后 notify 不再发请求', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: rpcResult(null) }))
    const client = new HttpJsonRpcClient({ url: URL })
    await client.shutdown()
    const callsAfterShutdown = fetchMock.mock.calls.length
    client.notify('notifications/initialized')
    expect(fetchMock.mock.calls.length).toBe(callsAfterShutdown)
  })
})

// ---------- shutdown ----------

describe('HttpJsonRpcClient — shutdown', () => {
  it('先发协议级 shutdown 请求（closed 标记之前），完成后通道关闭', async () => {
    fetchMock.mockResolvedValue(makeResponse({ body: rpcResult(null) }))
    const client = new HttpJsonRpcClient({ url: URL })
    await client.shutdown()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { method: string }
    expect(body.method).toBe('shutdown')
    expect(client.transportClosed).toBe(true)
  })

  it('shutdown 服务器超时/失败仍关闭通道，并 abort 进行中的请求', async () => {
    // 所有请求挂起，且响应 abort 信号
    fetchMock.mockImplementation((_u: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    })

    const client = new HttpJsonRpcClient({ url: URL })
    // 先发起一个慢请求（inflight）
    const slow = client.request('tools/call', { x: 1 })

    // shutdown 协议请求 50ms 超时 → closed → abort inflight
    await client.shutdown(50)
    expect(client.transportClosed).toBe(true)
    // 慢请求被 abort 后，request 统一收口为「请求超时」错误
    await expect(slow).rejects.toThrow('JSON-RPC 请求超时: tools/call')
  })
})
