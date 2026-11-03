// registry：请求限幅、结果归一化/去重、provider 选择与错误分档。
// provider 网络层 mock 掉，验证「统一收口」这一层。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/search/provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/search/provider-fetch')>()
  return { ...actual, providerFetchJson: vi.fn() }
})

import { providerFetchJson, ProviderFetchError } from '../src/main/search/provider-fetch'
import {
  runSearch,
  normalizeSearchQuery,
  normalizeSearchCount,
  normalizeSearchHits,
  canonicalUrl
} from '../src/main/search/registry'
import type { SearchRuntimeConfig } from '../src/main/search/types'

const mockFetchJson = vi.mocked(providerFetchJson)

function cfg(overrides: Partial<SearchRuntimeConfig> = {}): SearchRuntimeConfig {
  return {
    provider: 'tavily',
    apiKey: 'sk-test',
    searxngBaseUrl: '',
    searxngAllowPrivate: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('请求参数限幅', () => {
  it('query 压缩空白并截断到 500 字符（超长追加 …）', () => {
    expect(normalizeSearchQuery('  a   b ')).toBe('a b')
    const long = normalizeSearchQuery('x'.repeat(600))
    expect(long.length).toBe(501)
    expect(long.endsWith('…')).toBe(true)
  })

  it('count：0/负数/NaN→5，超过 8→8，小数向下取整', () => {
    expect(normalizeSearchCount(0)).toBe(5)
    expect(normalizeSearchCount(-1)).toBe(5)
    expect(normalizeSearchCount(NaN)).toBe(5)
    expect(normalizeSearchCount(99)).toBe(8)
    expect(normalizeSearchCount(3.9)).toBe(3)
    expect(normalizeSearchCount('2')).toBe(2)
  })
})

describe('结果归一化', () => {
  it('标题 200/摘要 400 截断、空值丢弃、非 http(s) 丢弃、按 URL 去重', () => {
    const hits = normalizeSearchHits(
      [
        { title: 'a'.repeat(250), url: 'https://a.example.com', snippet: 's'.repeat(450) },
        { title: '', url: 'https://empty-title', snippet: 'x' },
        { title: 'no-url', url: '', snippet: 'x' },
        { title: 'mailto', url: 'mailto:a@b.com', snippet: 'x' },
        { title: 'dup', url: 'https://a.example.com', snippet: 'dup' },
        { title: 'tracked', url: 'https://b.example.com/?utm_source=x&id=1', snippet: 'b' }
      ],
      3
    )
    expect(hits).toHaveLength(2)
    expect(hits[0]!.title.length).toBe(201)
    expect(hits[0]!.title.endsWith('…')).toBe(true)
    expect(hits[0]!.snippet.length).toBe(401)
    expect(hits[1]!.url).toBe('https://b.example.com/?id=1')
  })

  it('canonicalUrl：去 fragment/跟踪参数/尾斜杠，非法 URL 原样返回', () => {
    expect(canonicalUrl('https://a.com/path/?utm_source=x&fbclid=y#top')).toBe('https://a.com/path')
    expect(canonicalUrl('not a url')).toBe('not a url')
  })
})

describe('provider 前置校验', () => {
  it('tavily/bocha 未配置 Key → 抛可引导错误，不发请求', async () => {
    await expect(runSearch(cfg({ apiKey: '' }), 'q')).rejects.toThrow('未配置搜索 API Key')
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('searxng 未配置地址 → 抛可引导错误', async () => {
    await expect(
      runSearch(cfg({ provider: 'searxng', apiKey: '', searxngBaseUrl: '' }), 'q')
    ).rejects.toThrow('未配置 SearXNG 实例地址')
  })

  it('searxng 私网地址未确认 → 拒绝且不发请求', async () => {
    await expect(
      runSearch(
        cfg({ provider: 'searxng', apiKey: '', searxngBaseUrl: 'http://127.0.0.1:8080' }),
        'q'
      )
    ).rejects.toThrow('需在配置中勾选')
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('searxng 私网已确认 → 精确 origin 透传给 provider-fetch', async () => {
    mockFetchJson.mockResolvedValueOnce({
      results: [{ title: 'T', url: 'https://t', content: 'S' }]
    })
    await runSearch(
      cfg({
        provider: 'searxng',
        apiKey: '',
        searxngBaseUrl: 'http://127.0.0.1:8080',
        searxngAllowPrivate: true
      }),
      'q'
    )
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:8080/search'),
      expect.objectContaining({ allowPrivateOrigin: 'http://127.0.0.1:8080' })
    )
  })

  it('searxng 公网地址 → 即便旧配置 allowPrivate=true 也不放行私网', async () => {
    mockFetchJson.mockResolvedValueOnce({ results: [] })
    await runSearch(
      cfg({
        provider: 'searxng',
        apiKey: '',
        searxngBaseUrl: 'https://searx.example.com',
        searxngAllowPrivate: true
      }),
      'q'
    )
    expect(mockFetchJson).toHaveBeenCalledWith(
      'https://searx.example.com/search?q=q&format=json',
      expect.objectContaining({ allowPrivateOrigin: undefined })
    )
  })
})

describe('错误分档（401/403 与 429 分文案）', () => {
  it('tavily 401 → 提示检查 API Key', async () => {
    mockFetchJson.mockRejectedValueOnce(new ProviderFetchError('HTTP 401', 401))
    await expect(runSearch(cfg(), 'q')).rejects.toThrow('鉴权失败（HTTP 401）：请检查 API Key')
  })

  it('searxng 403 → 提示检查实例地址/JSON 输出（不误报 Key）', async () => {
    mockFetchJson.mockRejectedValueOnce(new ProviderFetchError('HTTP 403', 403))
    await expect(
      runSearch(cfg({ provider: 'searxng', apiKey: '', searxngBaseUrl: 'https://s.example.com' }), 'q')
    ).rejects.toThrow('SearXNG 拒绝访问（HTTP 403）：请检查实例地址、是否已开启 JSON 输出')
  })

  it('429 → 限流文案', async () => {
    mockFetchJson.mockRejectedValueOnce(new ProviderFetchError('HTTP 429', 429))
    await expect(runSearch(cfg(), 'q')).rejects.toThrow('限流（HTTP 429）')
  })

  it('5xx → 暂时不可用文案', async () => {
    mockFetchJson.mockRejectedValueOnce(new ProviderFetchError('HTTP 503', 503))
    await expect(runSearch(cfg(), 'q')).rejects.toThrow('暂时不可用（HTTP 503）')
  })

  it('200 的无效 JSON → 保留原错误，不被泛化成 HTTP 200', async () => {
    mockFetchJson.mockRejectedValueOnce(
      new ProviderFetchError('搜索服务返回了无效的 JSON 响应', 200)
    )
    await expect(runSearch(cfg(), 'q')).rejects.toThrow('无效的 JSON')
  })
})

describe('成功路径统一归一化', () => {
  it('provider 返回的脏数据在 registry 收口：截断/过滤/限条数', async () => {
    mockFetchJson.mockResolvedValueOnce({
      results: [
        { title: 'A', url: 'https://a', content: 'x'.repeat(600) },
        { title: '', url: 'https://b', content: 'skip' },
        { title: 'C', url: 'javascript:alert(1)', content: 'skip' }
      ]
    })
    const hits = await runSearch(cfg(), 'q', 8)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet.length).toBe(401)
  })
})
