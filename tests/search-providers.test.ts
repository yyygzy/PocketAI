// provider 契约三套：只验证「请求形状 + 响应拆解 + 错误透传」，
// 归一化/限幅/去重由 registry 统一负责（见 search-registry.test.ts）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/search/provider-fetch', () => ({
  providerFetchJson: vi.fn()
}))

import { providerFetchJson } from '../src/main/search/provider-fetch'
import { tavilyProvider } from '../src/main/search/providers/tavily'
import { bochaProvider } from '../src/main/search/providers/bocha'
import { searxngProvider } from '../src/main/search/providers/searxng'

const mockFetchJson = vi.mocked(providerFetchJson)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Tavily provider', () => {
  it('POST api.tavily.com/search，body 带 api_key/query/max_results', async () => {
    mockFetchJson.mockResolvedValueOnce({
      results: [{ title: 'T1', url: 'https://t1.example.com', content: 'S1' }]
    })
    const raw = await tavilyProvider.search({ query: 'q', count: 3, apiKey: 'sk-t' })
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ api_key: 'sk-t', query: 'q', max_results: 3 }),
        timeoutMs: 15_000
      })
    )
    expect(raw).toEqual([{ title: 'T1', url: 'https://t1.example.com', snippet: 'S1' }])
  })

  it('兼容少数响应给 snippet 而不是 content', async () => {
    mockFetchJson.mockResolvedValueOnce({
      results: [{ title: 'T', url: 'https://x', snippet: 'S' }]
    })
    expect(await tavilyProvider.search({ query: 'q', count: 1, apiKey: 'k' })).toEqual([
      { title: 'T', url: 'https://x', snippet: 'S' }
    ])
  })

  it('响应非对象/缺 results → 按空/解析失败处理', async () => {
    mockFetchJson.mockResolvedValueOnce(null)
    await expect(tavilyProvider.search({ query: 'q', count: 1, apiKey: 'k' })).rejects.toThrow(
      '搜索响应解析失败'
    )
    mockFetchJson.mockResolvedValueOnce({})
    expect(await tavilyProvider.search({ query: 'q', count: 1, apiKey: 'k' })).toEqual([])
  })

  it('provider-fetch 抛错（401/超时等）原样上抛给 registry 分档', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('搜索失败 HTTP 401'))
    await expect(tavilyProvider.search({ query: 'q', count: 1, apiKey: 'k' })).rejects.toThrow(
      'HTTP 401'
    )
  })
})

describe('Bocha provider', () => {
  it('POST api.bochaai.com/v1/web-search，Bearer + count/summary', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: { webPages: { value: [{ name: 'B1', url: 'https://b1', snippet: 'BS' }] } }
    })
    const raw = await bochaProvider.search({ query: 'q', count: 4, apiKey: 'sk-b' })
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://api.bochaai.com/v1/web-search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-b' }),
        body: JSON.stringify({ query: 'q', count: 4, summary: true })
      })
    )
    expect(raw).toEqual([{ title: 'B1', url: 'https://b1', snippet: 'BS' }])
  })

  it('summary 字段回退作为 snippet', async () => {
    mockFetchJson.mockResolvedValueOnce({
      data: { webPages: { value: [{ name: 'B', url: 'https://b', summary: 'SUM' }] } }
    })
    expect(await bochaProvider.search({ query: 'q', count: 1, apiKey: 'k' })).toEqual([
      { title: 'B', url: 'https://b', snippet: 'SUM' }
    ])
  })

  it('响应非对象 → 抛解析失败；缺 data → 空数组', async () => {
    mockFetchJson.mockResolvedValueOnce(null)
    await expect(bochaProvider.search({ query: 'q', count: 1, apiKey: 'k' })).rejects.toThrow(
      '搜索响应解析失败'
    )
    mockFetchJson.mockResolvedValueOnce({})
    expect(await bochaProvider.search({ query: 'q', count: 1, apiKey: 'k' })).toEqual([])
  })
})

describe('SearXNG provider（零 Key）', () => {
  it('拼 /search?q=...&format=json，并透传 guardHost/allowPrivateOrigin', async () => {
    mockFetchJson.mockResolvedValueOnce({
      results: [{ title: 'S1', url: 'https://s1', content: 'SC' }]
    })
    const raw = await searxngProvider.search({
      query: '中文 空格&符号',
      count: 5,
      apiKey: '',
      baseUrl: 'https://searx.example.com/',
      allowPrivateOrigin: 'https://searx.example.com'
    })
    const url = mockFetchJson.mock.calls[0]![0] as string
    expect(url).toBe(
      `https://searx.example.com/search?q=${encodeURIComponent('中文 空格&符号')}&format=json`
    )
    expect(mockFetchJson).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        guardHost: true,
        allowPrivateOrigin: 'https://searx.example.com',
        timeoutMs: 15_000
      })
    )
    expect(raw).toEqual([{ title: 'S1', url: 'https://s1', snippet: 'SC' }])
  })

  it('保留子路径基地址（不重置到根）', async () => {
    mockFetchJson.mockResolvedValueOnce({ results: [] })
    await searxngProvider.search({
      query: 'q',
      count: 1,
      apiKey: '',
      baseUrl: 'https://searx.example.com/searxng/'
    })
    expect(mockFetchJson.mock.calls[0]![0]).toBe(
      'https://searx.example.com/searxng/search?q=q&format=json'
    )
  })

  it('未配置地址 → 直接抛错，不发请求', async () => {
    await expect(
      searxngProvider.search({ query: 'q', count: 1, apiKey: '', baseUrl: '' })
    ).rejects.toThrow('未配置 SearXNG 实例地址')
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('响应非对象 → 解析失败；缺 results → 空数组', async () => {
    mockFetchJson.mockResolvedValueOnce(null)
    await expect(
      searxngProvider.search({
        query: 'q',
        count: 1,
        apiKey: '',
        baseUrl: 'https://searx.example.com'
      })
    ).rejects.toThrow('搜索响应解析失败')
    mockFetchJson.mockResolvedValueOnce({})
    expect(
      await searxngProvider.search({
        query: 'q',
        count: 1,
        apiKey: '',
        baseUrl: 'https://searx.example.com'
      })
    ).toEqual([])
  })
})
