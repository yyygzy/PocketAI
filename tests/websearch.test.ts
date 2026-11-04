// runWebSearch 适配层测试
//
// 职责边界：websearch.ts 只判断「是否启用」与「走 quick 还是 deep」，
// 其余（provider/限幅/归一化/错误分档）在 main/search；deep 编排见 search-deep 测试。
// 因此这里 mock registry / deep，只验证启用语义、默认深度与参数透传。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/tools/websearch-config', () => ({
  getWebSearchSecret: vi.fn()
}))
vi.mock('../src/main/search/registry', () => ({
  runSearch: vi.fn()
}))
vi.mock('../src/main/search/deep', () => ({
  runDeepSearch: vi.fn()
}))

import { runWebSearch, WebSearchDisabledError } from '../src/main/tools/websearch'
import { getWebSearchSecret } from '../src/main/tools/websearch-config'
import { runSearch } from '../src/main/search/registry'
import { runDeepSearch } from '../src/main/search/deep'

const mockSecret = vi.mocked(getWebSearchSecret)
const mockRunSearch = vi.mocked(runSearch)
const mockRunDeepSearch = vi.mocked(runDeepSearch)

function setSecret(opts: {
  enabled?: boolean
  provider?: 'tavily' | 'bocha' | 'searxng'
  apiKey?: string
  searxngBaseUrl?: string
  searxngAllowPrivate?: boolean
  depth?: 'auto' | 'quick' | 'deep'
}): void {
  mockSecret.mockReturnValue({
    enabled: opts.enabled ?? true,
    provider: opts.provider ?? 'tavily',
    apiKey: opts.apiKey ?? 'test-key',
    searxngBaseUrl: opts.searxngBaseUrl ?? '',
    searxngAllowPrivate: opts.searxngAllowPrivate ?? false,
    depth: opts.depth ?? 'auto'
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setSecret({})
  mockRunSearch.mockResolvedValue([])
})

describe('runWebSearch 启用语义', () => {
  it('未启用 → 抛 WebSearchDisabledError（供 builtin 转结构化指引）', async () => {
    setSecret({ enabled: false })
    await expect(runWebSearch('test')).rejects.toBeInstanceOf(WebSearchDisabledError)
    expect(mockRunSearch).not.toHaveBeenCalled()
  })

  it('已启用 → 把 provider/密钥/SearXNG 配置与 signal 原样交给 registry', async () => {
    setSecret({
      provider: 'searxng',
      apiKey: '',
      searxngBaseUrl: 'https://searx.example.com',
      searxngAllowPrivate: true
    })
    const ctrl = new AbortController()
    await runWebSearch('hello', 3, ctrl.signal)
    expect(mockRunSearch).toHaveBeenCalledWith(
      {
        provider: 'searxng',
        apiKey: '',
        searxngBaseUrl: 'https://searx.example.com',
        searxngAllowPrivate: true
      },
      'hello',
      3,
      ctrl.signal
    )
  })

  it('registry 抛错原样上抛（由 builtin 决定是否报错）', async () => {
    mockRunSearch.mockRejectedValueOnce(new Error('未配置搜索 API Key'))
    await expect(runWebSearch('q')).rejects.toThrow('未配置搜索 API Key')
  })
})

describe('runWebSearch 深度分发', () => {
  const runtime = {
    provider: 'tavily' as const,
    apiKey: 'test-key',
    searxngBaseUrl: '',
    searxngAllowPrivate: false
  }

  it('默认（auto 档且模型未点名）→ 按 schema 默认走 quick', async () => {
    await runWebSearch('q')
    expect(mockRunDeepSearch).not.toHaveBeenCalled()
    expect(mockRunSearch).toHaveBeenCalledTimes(1)
  })

  it('auto 档 → 模型的选择原样透传（deep 就 deep）', async () => {
    mockRunDeepSearch.mockResolvedValueOnce({
      depth: 'deep',
      query: 'q',
      results: [],
      text: '深度检索（3 路）：无搜索结果',
      angles: 3,
      truncated: false
    })
    const ctrl = new AbortController()
    await runWebSearch('q', 6, ctrl.signal, 'deep')
    expect(mockRunSearch).not.toHaveBeenCalled()
    expect(mockRunDeepSearch).toHaveBeenCalledWith(runtime, 'q', 6, ctrl.signal)
  })

  it('配置 quick → 强制覆盖模型点名 deep（实际走 quick）', async () => {
    setSecret({ depth: 'quick' })
    await runWebSearch('q', 5, undefined, 'deep')
    expect(mockRunDeepSearch).not.toHaveBeenCalled()
    expect(mockRunSearch).toHaveBeenCalledTimes(1)
  })

  it('配置 deep → 强制覆盖模型点名 quick（实际走 deep）', async () => {
    setSecret({ depth: 'deep' })
    mockRunDeepSearch.mockResolvedValueOnce({
      depth: 'deep',
      query: 'q',
      results: [],
      text: '深度检索（3 路）：无搜索结果',
      angles: 3,
      truncated: false
    })
    await runWebSearch('q', 5, undefined, 'quick')
    expect(mockRunSearch).not.toHaveBeenCalled()
    expect(mockRunDeepSearch).toHaveBeenCalledTimes(1)
  })

  it('配置 deep、模型未点名 → 走 deep（默认档不是 quick 时以配置为准）', async () => {
    setSecret({ depth: 'deep' })
    mockRunDeepSearch.mockResolvedValueOnce({
      depth: 'deep',
      query: 'q',
      results: [],
      text: '深度检索（3 路）：无搜索结果',
      angles: 3,
      truncated: false
    })
    await runWebSearch('q')
    expect(mockRunSearch).not.toHaveBeenCalled()
    expect(mockRunDeepSearch).toHaveBeenCalledTimes(1)
  })
})
