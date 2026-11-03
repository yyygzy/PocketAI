// provider-fetch 出网层：全局 fetch（代理感知）、3xx 拒绝、超时、字节上限、
// JSON 解析、私网精确 origin 放行（默认拒绝）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { assertProviderHostAllowed, providerFetchJson, ProviderFetchError } from '../src/main/search/provider-fetch'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('providerFetchJson — 正常路径', () => {
  it('走全局 fetch（main/net/proxy.ts 已替换为代理感知实现）并解析 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const json = await providerFetchJson<{ ok: boolean }>('https://api.tavily.com/search', {
      method: 'POST',
      body: '{"q":"x"}'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(json).toEqual({ ok: true })
  })

  it('空响应体 → 解析为 null（由 provider 判空）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 })) as unknown as typeof fetch
    expect(await providerFetchJson('https://example.com')).toBeNull()
  })
})

describe('providerFetchJson — 失败路径', () => {
  it('3xx → 拒绝跟随（防 Key 被转发）', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'https://evil.example.com' } })
      ) as unknown as typeof fetch
    await expect(providerFetchJson('https://api.tavily.com/search')).rejects.toThrow('重定向')
  })

  it('401/429/5xx 保留状态码，供 registry 分档', async () => {
    for (const status of [401, 429, 503]) {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('denied', { status })) as unknown as typeof fetch
      await expect(providerFetchJson('https://example.com')).rejects.toMatchObject({
        name: 'ProviderFetchError',
        status
      })
    }
  })

  it('无效 JSON → ProviderFetchError', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch
    await expect(providerFetchJson('https://example.com')).rejects.toThrow('无效的 JSON')
  })

  it('超时 → 中止请求并报超时', async () => {
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch
    await expect(providerFetchJson('https://example.com', { timeoutMs: 10 })).rejects.toThrow('超时')
  })

  it('外部 signal 已中止 → 报已中止', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')) as unknown as typeof fetch
    await expect(providerFetchJson('https://example.com', { signal: ctrl.signal })).rejects.toThrow('已中止')
  })

  it('响应体超过 maxBytes → 中止并报上限', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(8)))
        controller.enqueue(new TextEncoder().encode('y'.repeat(8)))
        controller.close()
      }
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200 })) as unknown as typeof fetch
    await expect(providerFetchJson('https://example.com', { maxBytes: 10 })).rejects.toThrow('上限')
  })
})

describe('私网放行边界（assertProviderHostAllowed）', () => {
  const lookup = vi.fn().mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

  it('默认拒绝环回/本机/内网后缀', async () => {
    for (const url of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://nas.local:8080']) {
      await expect(assertProviderHostAllowed(new URL(url), undefined, lookup)).rejects.toThrow(
        '禁止访问内网主机'
      )
    }
  })

  it('精确 origin 一致时放行环回；不一致仍拒绝', async () => {
    await expect(
      assertProviderHostAllowed(
        new URL('http://127.0.0.1:8080/search'),
        'http://127.0.0.1:8080',
        lookup
      )
    ).resolves.toBeUndefined()
    await expect(
      assertProviderHostAllowed(
        new URL('http://127.0.0.1:9090/search'),
        'http://127.0.0.1:8080',
        lookup
      )
    ).rejects.toThrow('禁止访问内网主机')
  })

  it('域名解析到私网 → 默认拒绝', async () => {
    await expect(
      assertProviderHostAllowed(new URL('https://evil.example.com'), undefined, lookup)
    ).rejects.toThrow('解析到内网')
  })

  it('域名解析到公网 → 放行', async () => {
    const publicLookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(
      assertProviderHostAllowed(new URL('https://public.example.com'), undefined, publicLookup)
    ).resolves.toBeUndefined()
  })

  it('guardHost=true 时 providerFetchJson 对私网地址在发请求前拒绝', async () => {
    const fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(
      providerFetchJson('http://127.0.0.1:8080/search', { guardHost: true })
    ).rejects.toBeInstanceOf(ProviderFetchError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('guardHost=true + 精确 origin 放行 → 正常发请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(
      providerFetchJson('http://127.0.0.1:8080/search', {
        guardHost: true,
        allowPrivateOrigin: 'http://127.0.0.1:8080'
      })
    ).resolves.toEqual({ results: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
