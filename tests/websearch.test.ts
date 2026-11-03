// runWebSearch 适配层测试
//
// 职责边界：websearch.ts 只判断「是否启用」，其余（provider/限幅/归一化/错误分档）
// 都在 main/search/registry。因此这里 mock registry，只验证启用语义与参数透传；
// provider 契约与归一化见 search-providers / search-registry 测试。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/tools/websearch-config', () => ({
  getWebSearchSecret: vi.fn()
}))
vi.mock('../src/main/search/registry', () => ({
  runSearch: vi.fn()
}))

import { runWebSearch, WebSearchDisabledError } from '../src/main/tools/websearch'
import { getWebSearchSecret } from '../src/main/tools/websearch-config'
import { runSearch } from '../src/main/search/registry'

const mockSecret = vi.mocked(getWebSearchSecret)
const mockRunSearch = vi.mocked(runSearch)

function setSecret(opts: {
  enabled?: boolean
  provider?: 'tavily' | 'bocha' | 'searxng'
  apiKey?: string
  searxngBaseUrl?: string
  searxngAllowPrivate?: boolean
}): void {
  mockSecret.mockReturnValue({
    enabled: opts.enabled ?? true,
    provider: opts.provider ?? 'tavily',
    apiKey: opts.apiKey ?? 'test-key',
    searxngBaseUrl: opts.searxngBaseUrl ?? '',
    searxngAllowPrivate: opts.searxngAllowPrivate ?? false
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
