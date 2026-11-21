// HttpJsonRpcClient 单元测试
//
// 覆盖 src/main/mcp/http-transport.ts 的核心路径：
// - spawn 空操作 / pid undefined / transportClosed
// - request：JSON 直响应 / SSE 流响应 / session ID 提取 / 超时 / 错误响应
// - notify：POST 发送不等响应
// - shutdown：中止进行中请求 + 标记 closed
// - H3：统一走 safeFetch（maxRedirects:0）、站点策略钩子、凭据头保护
//
// 策略：mock safeFetch，返回可控的 SafeFetchResult。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HttpJsonRpcClient } from '../src/main/mcp/http-transport'
import { SafeFetchError, safeFetch } from '../src/main/net/safe-fetch'

const fetchMock = vi.hoisted(() => ({
  impl: (async () => ({})) as (url: string, init: Record<string, any>) => Promise<any>,
  calls: [] as Array<{ url: string; init: Record<string, any> }>,
  reset() {
    this.impl = async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'),
      finalUrl: 'https://example.com/mcp'
    })
    this.calls = []
  }
}))

vi.mock('../src/main/net/safe-fetch', () => {
  class SafeFetchError extends Error {}
  return {
    SafeFetchError,
    safeFetch: vi.fn(async (url: string, init: Record<string, any>) => {
      fetchMock.calls.push({ url, init })
      if (init?.signal?.aborted) throw new SafeFetchError('已中止')
      if (!init?.signal) return fetchMock.impl(url, init)
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new SafeFetchError('已中止')),
          { once: true }
        )
        fetchMock.impl(url, init).then(resolve, reject)
      })
    })
  }
})

const mockSafeFetch = vi.mocked(safeFetch)

function jsonResult(data: unknown, headers: Record<string, string> = {}): any {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(data)),
    finalUrl: 'https://example.com/mcp'
  }
}

function sseResult(events: Array<{ event: string; data: string }>, headers: Record<string, string> = {}): any {
  const body = events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join('')
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
    body: Buffer.from(body),
    finalUrl: 'https://example.com/mcp'
  }
}

beforeEach(() => {
  fetchMock.reset()
})

afterEach(() => {
  vi.clearAllMocks()
})

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
    fetchMock.impl = async () => jsonResult({
      jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_time' }] }
    })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const r = await c.request('tools/list', {})
    expect(r).toEqual({ tools: [{ name: 'get_time' }] })
  })

  it('JSON 直响应：error 抛错', async () => {
    fetchMock.impl = async () => jsonResult({
      jsonrpc: '2.0', id: 1, error: { code: -32600, message: '无效请求' }
    })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/list')).rejects.toThrow('无效请求 (code=-32600)')
  })

  it('SSE 流响应：等待 result 事件', async () => {
    fetchMock.impl = async () => sseResult([
      { event: 'notification', data: '{"jsonrpc":"2.0","method":"progress"}' },
      { event: 'result', data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' }
    ])
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    const r = await c.request('tools/call', { name: 'search' })
    expect(r).toEqual({ ok: true })
  })

  it('SSE 流响应：notification 转发给 onNotification', async () => {
    fetchMock.impl = async () => sseResult([
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
    fetchMock.impl = async () => sseResult([
      { event: 'notification', data: '{"jsonrpc":"2.0","method":"ping"}' }
    ])
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/call')).rejects.toThrow('SSE 流结束未收到 result')
  })

  it('Mcp-Session-Id 从响应 header 提取，后续请求带上', async () => {
    fetchMock.impl = async () => jsonResult(
      { jsonrpc: '2.0', id: 1, result: {} },
      { 'mcp-session-id': 'sess-abc-123' }
    )
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.request('initialize')
    expect(fetchMock.calls[0]!.init.headers['Mcp-Session-Id']).toBeUndefined()

    await c.request('tools/list')
    expect(fetchMock.calls[1]!.init.headers['Mcp-Session-Id']).toBe('sess-abc-123')
  })

  it('超时 → throw AbortError 包装', async () => {
    fetchMock.impl = async () => new Promise<any>(() => {}) // 永不返回
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

  it('POST 请求带正确 header 和 body，且走 safeFetch（maxRedirects:0）', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.request('initialize', { protocolVersion: '2024-11-05' })
    expect(fetchMock.calls).toHaveLength(1)
    const call = fetchMock.calls[0]!
    expect(call.url).toBe('https://example.com/mcp')
    expect(call.init.method).toBe('POST')
    expect(call.init.headers['Content-Type']).toBe('application/json')
    expect(call.init.headers.Accept).toBe('text/event-stream')
    expect(call.init.maxRedirects).toBe(0)
    expect(mockSafeFetch).toHaveBeenCalled()
    const body = JSON.parse(call.init.body)
    expect(body.method).toBe('initialize')
    expect(body.jsonrpc).toBe('2.0')
  })

  it('3xx（safeFetch 拒绝跳转）→ 连接级失败', async () => {
    fetchMock.impl = async () => { throw new SafeFetchError('重定向次数超限') }
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/list')).rejects.toThrow('重定向次数超限')
  })

  it('401/403 → McpAuthError，不回显响应体', async () => {
    fetchMock.impl = async () => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('token=secret'),
      finalUrl: 'https://example.com/mcp'
    })
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await expect(c.request('tools/list')).rejects.toMatchObject({ name: 'McpAuthError', status: 401 })
  })
})

describe('HttpJsonRpcClient — 站点策略与凭据保护（H3）', () => {
  it('checkHostAllowed 每次请求都执行，返回值作为 allowPrivateOrigin 传给 safeFetch', async () => {
    const hostCheck = vi.fn(() => 'https://example.com')
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp', checkHostAllowed: hostCheck })
    await c.request('tools/list')
    await c.request('tools/list')
    expect(hostCheck).toHaveBeenCalledTimes(2)
    expect(fetchMock.calls[0]!.init.allowPrivateOrigin).toBe('https://example.com')
  })

  it('站点策略拒绝 → 不出网', async () => {
    const c = new HttpJsonRpcClient({
      url: 'https://evil.example/mcp',
      checkHostAllowed: () => { throw new Error('MCP_HOST_BLOCKED') }
    })
    await expect(c.request('tools/list')).rejects.toThrow('MCP_HOST_BLOCKED')
    expect(fetchMock.calls).toHaveLength(0)
  })

  it('凭据头在 host 未放行时剥离；放行时保留', async () => {
    const headers = {
      Authorization: 'Bearer secret',
      Cookie: 'sid=abc',
      'X-Api-Key': 'key',
      Accept: 'application/json'
    }
    const blocked = new HttpJsonRpcClient({
      url: 'https://example.com/mcp', headers, credentialsAllowed: false
    })
    await blocked.request('tools/list')
    const sent = fetchMock.calls[0]!.init.headers
    expect(sent.Authorization).toBeUndefined()
    expect(sent.Cookie).toBeUndefined()
    expect(sent['X-Api-Key']).toBeUndefined()
    expect(sent.Accept).toBe('text/event-stream') // 协议头后写优先

    const allowed = new HttpJsonRpcClient({
      url: 'https://example.com/mcp', headers, credentialsAllowed: true
    })
    await allowed.request('tools/list')
    const sent2 = fetchMock.calls[1]!.init.headers
    expect(sent2.Authorization).toBe('Bearer secret')
    expect(sent2['X-Api-Key']).toBe('key')
  })
})

describe('HttpJsonRpcClient — notify', () => {
  it('发送 POST 不等响应', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    c.notify('notifications/initialized')
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock.calls).toHaveLength(1)
    const body = JSON.parse(fetchMock.calls[0]!.init.body)
    expect(body.method).toBe('notifications/initialized')
    expect(body.id).toBeUndefined()
  })

  it('被站点策略拒绝时静默放弃', async () => {
    const c = new HttpJsonRpcClient({
      url: 'https://example.com/mcp',
      checkHostAllowed: () => { throw new Error('MCP_HOST_BLOCKED') }
    })
    c.notify('test')
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock.calls).toHaveLength(0)
  })

  it('closed 后 notify 静默', async () => {
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp' })
    await c.shutdown()
    const callsAfterShutdown = fetchMock.calls.length
    c.notify('test')
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock.calls).toHaveLength(callsAfterShutdown)
  })
})

describe('HttpJsonRpcClient — shutdown', () => {
  it('中止进行中的请求', async () => {
    fetchMock.impl = async () => new Promise<any>(() => {}) // 挂起
    const c = new HttpJsonRpcClient({ url: 'https://example.com/mcp', requestTimeout: 60000 })
    const p = c.request('tools/list')
    await Promise.resolve()
    await c.shutdown()
    await expect(p).rejects.toThrow()
  })
})
