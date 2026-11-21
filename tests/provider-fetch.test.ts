// provider-fetch 出网层：统一走 safeFetch（DNS 校验/IP pinning/字节上限）、3xx 拒绝、
// 超时、JSON 解析、私网精确 origin 放行（默认拒绝）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { safeFetch, SafeFetchError, type SafeFetchResult } from '../src/main/net/safe-fetch'
import { assertProviderHostAllowed, providerFetchJson, ProviderFetchError } from '../src/main/search/provider-fetch'

vi.mock('../src/main/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/net/safe-fetch')>()
  return { ...actual, safeFetch: vi.fn() }
})

const mockSafeFetch = vi.mocked(safeFetch)
const originalFetch = globalThis.fetch

function result(body: string, status = 200): SafeFetchResult {
  return {
    status,
    headers: {},
    body: Buffer.from(body, 'utf8'),
    finalUrl: 'https://example.com'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('providerFetchJson — 正常路径', () => {
  it('统一走 safeFetch（DNS pinning），不经全局 fetch，并解析 JSON', async () => {
    mockSafeFetch.mockResolvedValueOnce(result('{"ok":true}'))
    const json = await providerFetchJson<{ ok: boolean }>('https://api.tavily.com/search', {
      method: 'POST',
      body: '{"q":"x"}'
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
    expect(mockSafeFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: '{"q":"x"}',
      maxRedirects: 0,
      useProxy: true
    })
    expect(json).toEqual({ ok: true })
  })

  it('空响应体 → 解析为 null（由 provider 判空）', async () => {
    mockSafeFetch.mockResolvedValueOnce(result(''))
    expect(await providerFetchJson('https://example.com')).toBeNull()
  })
})

describe('providerFetchJson — 失败路径', () => {
  it('3xx → 拒绝跟随（防 Key 被转发）', async () => {
    mockSafeFetch.mockRejectedValueOnce(new SafeFetchError('重定向次数超限'))
    await expect(providerFetchJson('https://api.tavily.com/search')).rejects.toThrow('重定向')
  })

  it('DNS 校验失败（疑似 DNS rebinding）→ 拒绝且不回退直连', async () => {
    mockSafeFetch.mockRejectedValueOnce(
      new SafeFetchError('目标解析到内网/保留地址，已拦截: public.example.com')
    )
    await expect(providerFetchJson('https://public.example.com/search')).rejects.toThrow('已拦截')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('401/429/5xx 保留状态码，供 registry 分档', async () => {
    for (const status of [401, 429, 503]) {
      mockSafeFetch.mockResolvedValueOnce(result('denied', status))
      await expect(providerFetchJson('https://example.com')).rejects.toMatchObject({
        name: 'ProviderFetchError',
        status
      })
    }
  })

  it('无效 JSON → ProviderFetchError', async () => {
    mockSafeFetch.mockResolvedValueOnce(result('<html>not json</html>'))
    await expect(providerFetchJson('https://example.com')).rejects.toThrow('无效的 JSON')
  })

  it('超时 → 中止请求并报超时', async () => {
    mockSafeFetch.mockImplementationOnce(
      (_url, opts) =>
        new Promise<SafeFetchResult>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(new SafeFetchError('SafeFetch 请求超时（等待响应）', 'ttfb'))
          )
        })
    )
    await expect(providerFetchJson('https://example.com', { timeoutMs: 10 })).rejects.toThrow('超时')
  })

  it('外部 signal 已中止 → 报已中止', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    mockSafeFetch.mockRejectedValueOnce(new SafeFetchError('已中止'))
    await expect(providerFetchJson('https://example.com', { signal: ctrl.signal })).rejects.toThrow('已中止')
  })

  it('响应体超过 maxBytes → safeFetch 拒绝，上限参数原样透传', async () => {
    mockSafeFetch.mockRejectedValueOnce(new SafeFetchError('响应体超过上限（0MB）'))
    await expect(providerFetchJson('https://example.com', { maxBytes: 10 })).rejects.toThrow('上限')
    expect(mockSafeFetch.mock.calls[0]![1]).toMatchObject({ maxBytes: 10 })
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

  it('guardHost=true 时私网地址在发请求前拒绝，safeFetch 也未调用', async () => {
    await expect(
      providerFetchJson('http://127.0.0.1:8080/search', { guardHost: true })
    ).rejects.toBeInstanceOf(ProviderFetchError)
    expect(mockSafeFetch).not.toHaveBeenCalled()
  })

  it('guardHost=true + 精确 origin 放行 → 仅该 origin 以 allowPrivateOrigin 传给 safeFetch', async () => {
    mockSafeFetch.mockResolvedValueOnce(result('{"results":[]}'))
    await expect(
      providerFetchJson('http://127.0.0.1:8080/search', {
        guardHost: true,
        allowPrivateOrigin: 'http://127.0.0.1:8080'
      })
    ).resolves.toEqual({ results: [] })
    expect(mockSafeFetch).toHaveBeenCalledTimes(1)
    expect(mockSafeFetch.mock.calls[0]![1]).toMatchObject({
      allowPrivateOrigin: 'http://127.0.0.1:8080'
    })
  })
})
