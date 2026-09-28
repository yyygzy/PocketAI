// websearch runWebSearch 全分支测试
//
// 覆盖 src/main/tools/websearch.ts 的 runWebSearch：
//  - 启用/Key 校验：未启用抛错、未配置 Key 抛错、query 空抛错
//  - count 边界：0/负数/NaN → DEFAULT_COUNT=5；超 8 → 8；正常 → 传入值
//  - tavily provider：POST tavily URL + body api_key/query/max_results；归一化 results（title 200 截断、snippet 400 截断、content??snippet fallback）
//  - bocha provider：POST bocha URL + Bearer + body query/count/summary；归一化 data.webPages.value（name→title、snippet??summary fallback）
//  - 重定向 3xx → 抛 '搜索服务返回重定向'
//  - HTTP <200 或 >=300 → 抛 '搜索失败 HTTP XXX'
//  - JSON 解析失败 → 抛 '搜索服务返回了无效的 JSON'
//  - 空响应解析为 null → 抛 '搜索响应解析失败'
//  - filter 过滤空 title/url
//
// 策略：mock getWebSearchSecret（可控 enabled/provider/apiKey）+ mock safeFetch（可控 status/body Buffer）；
//       验证 safeFetch 调用参数（URL/method/headers/body/maxRedirects）。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/tools/websearch-config', () => ({
  getWebSearchSecret: vi.fn()
}))
vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: vi.fn()
}))

import { runWebSearch } from '../src/main/tools/websearch'
import { getWebSearchSecret } from '../src/main/tools/websearch-config'
import { safeFetch } from '../src/main/net/safe-fetch'

const mockSecret = vi.mocked(getWebSearchSecret)
const mockSafeFetch = vi.mocked(safeFetch)

function setSecret(opts: { enabled?: boolean; provider?: 'tavily' | 'bocha'; apiKey?: string }): void {
  mockSecret.mockReturnValue({
    enabled: opts.enabled ?? true,
    provider: opts.provider ?? 'tavily',
    apiKey: opts.apiKey ?? 'test-key'
  })
}

function mockResponse(status: number, body: string): void {
  mockSafeFetch.mockResolvedValueOnce({ status, body: Buffer.from(body, 'utf8') } as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  setSecret({})
})

// ── 启用与 Key 校验 ──────────────────────────────────────

describe('runWebSearch 启用与 Key 校验', () => {
  it('未启用 → 抛 联网搜索未启用', async () => {
    setSecret({ enabled: false })
    await expect(runWebSearch('test')).rejects.toThrow('联网搜索未启用')
  })

  it('未配置 Key → 抛 未配置搜索 API Key', async () => {
    setSecret({ apiKey: '' })
    await expect(runWebSearch('test')).rejects.toThrow('未配置搜索 API Key')
  })

  it('query 空串 → 抛 query 不能为空', async () => {
    await expect(runWebSearch('')).rejects.toThrow('query 不能为空')
  })

  it('query 全空白 → cut 后空 → 抛 query 不能为空', async () => {
    await expect(runWebSearch('   ')).rejects.toThrow('query 不能为空')
  })
})

// ── count 边界 ───────────────────────────────────────────

describe('runWebSearch count 边界', () => {
  it('count 0/负数/NaN → DEFAULT_COUNT=5', async () => {
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('x', 0)
    const body = JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body)
    expect(body.max_results).toBe(5)

    vi.clearAllMocks()
    setSecret({})
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('x', -3)
    expect(JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body).max_results).toBe(5)

    vi.clearAllMocks()
    setSecret({})
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('x', NaN)
    expect(JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body).max_results).toBe(5)
  })

  it('count 超 8 → 截断为 8', async () => {
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('x', 20)
    expect(JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body).max_results).toBe(8)
  })

  it('count 正常 1-8 → 透传', async () => {
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('x', 3)
    expect(JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body).max_results).toBe(3)
  })
})

// ── tavily provider ──────────────────────────────────────

describe('runWebSearch tavily provider', () => {
  it('POST tavily URL + body api_key/query/max_results + maxRedirects=0', async () => {
    mockResponse(200, JSON.stringify({ results: [] }))
    await runWebSearch('hello', 5)
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        maxRedirects: 0,
        body: expect.stringContaining('"api_key":"test-key"')
      })
    )
    const body = JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body)
    expect(body.query).toBe('hello')
    expect(body.max_results).toBe(5)
  })

  it('归一化 results 数组（title/snippet 截断 + content??snippet fallback）', async () => {
    mockResponse(200, JSON.stringify({
      results: [
        { title: 'T1', url: 'https://t1', content: '内容1' },
        { title: 'T2', url: 'https://t2', snippet: '摘要2' },
        { title: 'a'.repeat(300), url: 'https://t3', content: 'b'.repeat(500) }
      ]
    }))
    const hits = await runWebSearch('q')
    expect(hits).toHaveLength(3)
    expect(hits[0]!.title).toBe('T1')
    expect(hits[0]!.url).toBe('https://t1')
    expect(hits[0]!.snippet).toBe('内容1')
    expect(hits[1]!.snippet).toBe('摘要2') // content 缺失 fallback snippet
    expect(hits[2]!.title.length).toBeLessThanOrEqual(201) // 200 + …
    expect(hits[2]!.snippet.length).toBeLessThanOrEqual(401) // 400 + …
  })
})

// ── bocha provider ───────────────────────────────────────

describe('runWebSearch bocha provider', () => {
  beforeEach(() => {
    setSecret({ provider: 'bocha' })
  })

  it('POST bocha URL + Bearer + body query/count/summary + maxRedirects=0', async () => {
    mockResponse(200, JSON.stringify({ data: { webPages: { value: [] } } }))
    await runWebSearch('hello', 5)
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://api.bochaai.com/v1/web-search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
        maxRedirects: 0,
        body: expect.stringContaining('"summary":true')
      })
    )
    const body = JSON.parse((mockSafeFetch.mock.calls[0]![1]! as any).body)
    expect(body.query).toBe('hello')
    expect(body.count).toBe(5)
  })

  it('归一化 data.webPages.value（name→title、snippet??summary fallback）', async () => {
    mockResponse(200, JSON.stringify({
      data: { webPages: { value: [
        { name: 'B1', url: 'https://b1', snippet: '摘要1' },
        { name: 'B2', url: 'https://b2', summary: '总结2' }
      ] } }
    }))
    const hits = await runWebSearch('q')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.title).toBe('B1')
    expect(hits[0]!.snippet).toBe('摘要1')
    expect(hits[1]!.snippet).toBe('总结2') // snippet 缺失 fallback summary
  })
})

// ── HTTP 错误分支 ─────────────────────────────────────────

describe('runWebSearch HTTP 错误分支', () => {
  it('3xx 重定向 → 抛 搜索服务返回重定向', async () => {
    mockResponse(302, '')
    await expect(runWebSearch('q')).rejects.toThrow('搜索服务返回重定向')
  })

  it('< 200 → 抛 搜索失败 HTTP', async () => {
    mockResponse(100, '')
    await expect(runWebSearch('q')).rejects.toThrow('搜索失败 HTTP 100')
  })

  it('>= 300（非 3xx）→ 抛 搜索失败 HTTP', async () => {
    mockResponse(500, 'server error')
    await expect(runWebSearch('q')).rejects.toThrow('搜索失败 HTTP 500')
  })

  it('错误响应体截断 200 字符', async () => {
    mockResponse(500, 'x'.repeat(500))
    try {
      await runWebSearch('q')
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('搜索失败 HTTP 500')
      // cut(text, 200) → 200 字符 + …；整体长度有界
      expect(msg.length).toBeLessThan('搜索失败 HTTP 500: '.length + 203)
    }
  })
})

// ── JSON 解析分支 ─────────────────────────────────────────

describe('runWebSearch JSON 解析分支', () => {
  it('无效 JSON → 抛 搜索服务返回了无效的 JSON', async () => {
    mockResponse(200, 'not-json{')
    await expect(runWebSearch('q')).rejects.toThrow('搜索服务返回了无效的 JSON')
  })

  it('空响应体 → JSON.parse("null") → json===null → 抛 搜索响应解析失败', async () => {
    mockResponse(200, '')
    await expect(runWebSearch('q')).rejects.toThrow('搜索响应解析失败')
  })
})

// ── filter 过滤 ─────────────────────────────────────────

describe('runWebSearch 结果过滤', () => {
  it('空 title 或空 url 的项被过滤掉', async () => {
    mockResponse(200, JSON.stringify({
      results: [
        { title: 'ok', url: 'https://ok', content: 'c' },
        { title: '', url: 'https://empty-title', content: 'c' },
        { title: 'empty-url', url: '', content: 'c' }
      ]
    }))
    const hits = await runWebSearch('q')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.title).toBe('ok')
  })
})
