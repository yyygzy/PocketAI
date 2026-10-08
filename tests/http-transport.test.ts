// HttpJsonRpcClient 单元测试
//
// 覆盖 src/main/mcp/http-transport.ts 的核心路径：
// - spawn 空操作 / pid undefined / transportClosed
// - request：JSON 直响应 / SSE 流响应 / session ID 提取 / 超时 / 错误响应
// - notify：POST 发送不等响应
// - shutdown：中止进行中请求 + 标记 closed
//
// 策略：vi.fn(global, 'fetch') 拦截，返回可控 Response 对象
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpJsonRpcClient } from '../src/main/mcp/http-transport'

// ---------- 工具：构造 fetch Response ----------

function makeJsonResponse(data: unknown, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(data)
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function makeSseResponse(events: Array<{ event: string; data: string }>, headers: Record<string, string> = {}): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers }
  })
}

// ---------- mock fetch ----------

const fetchMock = vi.hoisted(() => ({
  impl: (async () => new Response()) as (url: string, init?: RequestInit) => Promise<Response>,
  calls: [] as Array<{ url: string; init: RequestInit }>,
  reset() {
    this.impl = async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
    this.calls = []
  }
}))

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  fetchMock.reset()
  originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchMock.calls.push({ url, init: init ?? {} })
    // 让 abort signal 能取消 fetch
    if (init?.signal) {
      const signal = init.signal
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        fetchMock.impl(url, init).then(resolve, reject)
      })
    }
    return fetchMock.impl(url, init)
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

// ---------- 用例 ----------

describe('HttpJsonRpcClient — 基础属性', () => {
  it('pid 恒为 undefined', () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    expect(c.pid).toBeUndefined()
  })

  it('transportClosed 初始 false，shutdown 后 true', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    expect(c.transportClosed).toBe(false)
    await c.shutdown()
    expect(c.transportClosed).toBe(true)
  })

  it('spawn 是空操作，不抛错', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.spawn()).resolves.toBeUndefined()
  })
})

describe('HttpJsonRpcClient — request', () => {
  it('JSON 直响应：解析 result 返回', async () => {
    fetchMock.impl = async () => makeJsonResponse({
      jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_time' }] }
    })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const r = await c.request('tools/list', {})
    expect(r).toEqual({ tools: [{ name: 'get_time' }] })
  })

  it('JSON 直响应：error 抛错', async () => {
    fetchMock.impl = async () => makeJsonResponse({
      jsonrpc: '2.0', id: 1, error: { code: -32600, message: '无效请求' }
    })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/list')).rejects.toThrow('无效请求 (code=-32600)')
  })

  it('SSE 流响应：等待 result 事件', async () => {
    fetchMock.impl = async () => makeSseResponse([
      { event: 'notification', data: '{"jsonrpc":"2.0","method":"progress"}' },
      { event: 'result', data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' }
    ])
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const r = await c.request('tools/call', { name: 'search' })
    expect(r).toEqual({ ok: true })
  })

  it('SSE 流响应：notification 转发给 onNotification', async () => {
    fetchMock.impl = async () => makeSseResponse([
      { event: 'notification', data: '{"jsonrpc":"2.0","method":"progress","params":{"step":1}}' },
      { event: 'result', data: '{"jsonrpc":"2.0","id":1,"result":{}}' }
    ])
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const notifications: unknown[] = []
    c.onNotification((n) => notifications.push(n))
    await c.request('tools/call')
    expect(notifications).toHaveLength(1)
    expect((notifications[0] as { method: string }).method).toBe('progress')
  })

  it('SSE 流结束未收到 result → throw', async () => {
    fetchMock.impl = async () => makeSseResponse([
      { event: 'notification', data: '{"jsonrpc":"2.0","method":"ping"}' }
    ])
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/call')).rejects.toThrow('SSE 流结束未收到 result')
  })

  it('Mcp-Session-Id 从响应 header 提取，后续请求带上', async () => {
    let capturedHeaders: Record<string, string> = {}
    fetchMock.impl = async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {}
      return makeJsonResponse(
        { jsonrpc: '2.0', id: 1, result: {} },
        { 'Mcp-Session-Id': 'sess-abc-123' }
      )
    }
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.request('initialize')
    expect(capturedHeaders['Mcp-Session-Id']).toBeUndefined()

    // 第二次请求应带 session ID
    await c.request('tools/list')
    expect(capturedHeaders['Mcp-Session-Id']).toBe('sess-abc-123')
  })

  it('超时 → throw AbortError 包装', async () => {
    fetchMock.impl = async () => new Promise<Response>(() => {}) // 永不返回
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp', requestTimeout: 50 })
    await expect(c.request('tools/list')).rejects.toThrow('超时')
  })

  it('closed 后 request → throw', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.shutdown()
    await expect(c.request('tools/list')).rejects.toThrow('已关闭')
  })

  it('请求体超过上限 → throw', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const huge = 'x'.repeat(33 * 1024 * 1024)
    await expect(c.request('tools/call', { data: huge })).rejects.toThrow('超过')
  })

  it('POST 请求带正确 header 和 body', async () => {
    fetchMock.impl = async () => makeJsonResponse({ jsonrpc: '2.0', id: 1, result: {} })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.request('initialize', { protocolVersion: '2024-11-05' })
    expect(fetchMock.calls).toHaveLength(1)
    const call = fetchMock.calls[0]!
    expect(call.url).toBe('https://example.com/mcp')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect((call.init.headers as Record<string, string>)['Accept']).toBe('text/event-stream')
    const body = JSON.parse(call.init.body as string)
    expect(body.method).toBe('initialize')
    expect(body.jsonrpc).toBe('2.0')
  })
})

describe('HttpJsonRpcClient — notify', () => {
  it('发送 POST 不等响应', async () => {
    fetchMock.impl = async () => makeJsonResponse({ jsonrpc: '2.0', result: {} })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    c.notify('notifications/initialized')
    // 等待 microtask 完成
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock.calls).toHaveLength(1)
    const body = JSON.parse(fetchMock.calls[0]!.init.body as string)
    expect(body.method).toBe('notifications/initialized')
    expect(body.id).toBeUndefined()
  })

  it('closed 后 notify 静默', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.shutdown()
    // shutdown 自身会发一个 fetch 请求
    const callsAfterShutdown = fetchMock.calls.length
    c.notify('test')
    await Promise.resolve()
    await Promise.resolve()
    // notify 不应增加新的 fetch 调用
    expect(fetchMock.calls).toHaveLength(callsAfterShutdown)
  })
})

describe('HttpJsonRpcClient — shutdown', () => {
  it('中止进行中的请求', async () => {
    fetchMock.impl = async () => new Promise<Response>(() => {}) // 挂起
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp', requestTimeout: 60000 })
    const p = c.request('tools/list')
    // 让 fetch 调用开始
    await Promise.resolve()
    await c.shutdown()
    await expect(p).rejects.toThrow()
  })
})
