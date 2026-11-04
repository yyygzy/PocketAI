// deep 搜索编排测试：全部走 mock，不打真网
//
// 覆盖：
// - 角度扩展（原 query + 2 个启发式变体，≤3 路）
// - 三路部分失败不拖垮整体（Promise.allSettled）
// - URL 归一化去重 / 同域最多 2 条 / 总数 ≤6
// - 只补读前 3 条正文；抓取失败回退 snippet；正文 ≤1200
// - 模型可见输出是纯文本编号清单（无 JSON 信封）：6 条接近上限仍 <2000（不触发压缩层）、
//   正文只渲染前 2 条、极端长 URL 保留骨架、truncated 与最终文本削没削一致
// - 单路 15s、整体 30s 预算、外部 abort
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/main/search/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/search/registry')>()
  return { ...actual, runSearch: vi.fn() }
})
vi.mock('../src/main/net/safe-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/net/safe-fetch')>()
  return { ...actual, safeFetch: vi.fn() }
})
vi.mock('../src/main/net/readable', () => ({
  extractTitle: vi.fn(() => ''),
  extractReadableText: vi.fn(async (html: string) => html)
}))

import { runSearch } from '../src/main/search/registry'
import { safeFetch } from '../src/main/net/safe-fetch'
import { extractReadableText } from '../src/main/net/readable'
import {
  buildSearchAngles,
  selectDeepHits,
  renderDeepText,
  runDeepSearch,
  DEEP_MAX_ANGLES,
  DEEP_MAX_RESULTS,
  DEEP_MAX_PER_DOMAIN,
  DEEP_TEXT_MAX_CHARS,
  DEEP_BODY_MAX_CHARS,
  DEEP_RENDER_BODY_CHARS,
  DEEP_RENDER_BODY_ITEMS,
  DEEP_TOP_BODIES,
  DEEP_ROUTE_TIMEOUT_MS,
  DEEP_TOTAL_BUDGET_MS
} from '../src/main/search/deep'
import type { DeepSearchHit } from '../src/main/search/deep'
import type { SearchHit, SearchRuntimeConfig } from '../src/main/search/types'

const mockRunSearch = vi.mocked(runSearch)
const mockSafeFetch = vi.mocked(safeFetch)
const mockReadable = vi.mocked(extractReadableText)

const cfg: SearchRuntimeConfig = {
  provider: 'tavily',
  apiKey: 'sk-test',
  searxngBaseUrl: '',
  searxngAllowPrivate: false
}

function hit(n: number, over: Partial<SearchHit> = {}): SearchHit {
  return {
    title: `T${n}`,
    url: `https://site${n}.example.com/a`,
    snippet: `S${n}`,
    ...over
  }
}

function okBody(text = '正文'): { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string } {
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: Buffer.from(`<html><body>${text}</body></html>`),
    finalUrl: 'https://example.com'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSafeFetch.mockResolvedValue(okBody())
  mockReadable.mockImplementation(async (html: string) => html)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildSearchAngles', () => {
  it('原 query + 2 个启发式变体，共 3 路', () => {
    expect(buildSearchAngles('量子计算')).toEqual(['量子计算', '量子计算 最新', '量子计算 分析'])
    expect(buildSearchAngles('量子计算').length).toBe(DEEP_MAX_ANGLES)
  })

  it('空白 query → 空数组（交由 runDeepSearch 报错）', () => {
    expect(buildSearchAngles('   ')).toEqual([])
  })
})

describe('selectDeepHits', () => {
  it('URL 归一化去重：utm 参数 / fragment / 尾斜杠算同一条', () => {
    const out = selectDeepHits([
      { title: 'a', url: 'https://Example.com/post/?utm_source=x&utm_medium=y#top', snippet: 's' },
      { title: 'b', url: 'https://example.com/post/', snippet: 's2' },
      { title: 'c', url: 'https://example.com/post#frag', snippet: 's3' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://example.com/post')
  })

  it('同域最多 2 条，第三条起跳过', () => {
    const out = selectDeepHits([
      hit(1, { url: 'https://same.example.com/1' }),
      hit(2, { url: 'https://same.example.com/2' }),
      hit(3, { url: 'https://same.example.com/3' }),
      hit(4, { url: 'https://other.example.com/4' })
    ])
    expect(out.map((h) => h.url)).toEqual([
      'https://same.example.com/1',
      'https://same.example.com/2',
      'https://other.example.com/4'
    ])
    expect(DEEP_MAX_PER_DOMAIN).toBe(2)
  })

  it('总数封顶 6 条', () => {
    const many = Array.from({ length: 9 }, (_, i) => hit(i + 1, { url: `https://d${i + 1}.example.com/a` }))
    expect(selectDeepHits(many)).toHaveLength(DEEP_MAX_RESULTS)
  })

  it('非法 URL 跳过（registry 已保证上游只产 http(s)）', () => {
    expect(selectDeepHits([
      hit(1, { url: 'not a url' }),
      hit(2, { url: 'https://ok.example.com/a' })
    ]).map((h) => h.url)).toEqual(['https://ok.example.com/a'])
  })
})

describe('renderDeepText — 模型可见纯文本清单', () => {
  /** 标题/摘要/正文都接近展示上限的一条结果 */
  function near(i: number, withBody = false): DeepSearchHit {
    return {
      title: `第${i}条搜索结果标题`.padEnd(30, '标'),
      url: `https://site${i}.example.com/path/to/article-${i}`,
      snippet: '摘'.repeat(120),
      ...(withBody ? { content: '正'.repeat(DEEP_BODY_MAX_CHARS) } : {})
    }
  }

  it('6 条接近上限（3 条带 1200 正文）→ 最终文本 <2000、6 个 URL、不再是 JSON', () => {
    const items = [1, 2, 3, 4, 5, 6].map((i) => near(i, i <= 3))
    const out = renderDeepText(items, 3)
    expect(out.text.length).toBeLessThan(2000)
    expect(out.text.length).toBeLessThanOrEqual(DEEP_TEXT_MAX_CHARS)
    for (let i = 1; i <= 6; i++) {
      expect(out.text).toContain(`[${i}] `)
      expect(out.text).toContain(`https://site${i}.example.com`)
    }
    expect(out.text.startsWith('深度检索')).toBe(true)
    expect(out.text).not.toContain('{"')
    expect(() => JSON.parse(out.text)).toThrow()
    // 正文 1200→300、摘要 120→80 都算真的削过
    expect(out.truncated).toBe(true)
  })

  it('正文只给前 2 条有正文的结果，其余只给摘要', () => {
    const out = renderDeepText([near(1, true), near(2, true), near(3, true)], 3)
    expect(out.text.match(/正文：/g)).toHaveLength(DEEP_RENDER_BODY_ITEMS)
    expect(DEEP_RENDER_BODY_ITEMS).toBe(2)
  })

  it('短结果、无正文 → 不降级、truncated=false', () => {
    const out = renderDeepText(
      [
        { title: 'A', url: 'https://a.example.com/', snippet: '短摘要' },
        { title: 'B', url: 'https://b.example.com/', snippet: '短摘要' }
      ],
      3
    )
    expect(out.truncated).toBe(false)
    expect(out.text.length).toBeLessThan(2000)
  })

  it('单条超长正文 → 保留骨架，绝不返回空；正文展示 ≤300 字', () => {
    const out = renderDeepText(
      [
        {
          title: '长文',
          url: 'https://a.example.com/long',
          snippet: '摘要',
          content: '正'.repeat(DEEP_BODY_MAX_CHARS)
        }
      ],
      3
    )
    expect(out.text.length).toBeGreaterThan(0)
    expect(out.text).toContain('[1] ')
    expect(out.text).toContain('https://a.example.com/long')
    const bodyLine = out.text.split('\n').find((l) => l.startsWith('正文：'))
    expect(bodyLine).toBeTruthy()
    expect(bodyLine!.length).toBeLessThanOrEqual('正文：'.length + DEEP_RENDER_BODY_CHARS + 1)
  })

  it('单条 URL 极端长 → 不崩不空，骨架（标题+URL）保留', () => {
    const longUrl = 'https://x.example.com/' + 'a'.repeat(3000)
    const out = renderDeepText([{ title: 'T', url: longUrl, snippet: '' }], 3)
    expect(out.text).toContain(`[1] T — ${longUrl}`)
    expect(out.truncated).toBe(true)
  })

  it('0 条 → 明确的空结果说明，不是空字符串', () => {
    const out = renderDeepText([], 3)
    expect(out.text).toBe('深度检索（3 路）：无搜索结果')
    expect(out.truncated).toBe(false)
  })
})

describe('runDeepSearch 编排', () => {
  it('部分路失败 → 只丢失败那一路，其余照常合并', async () => {
    mockRunSearch.mockImplementation(async (_cfg, angle) => {
      if (angle.endsWith('最新')) throw new Error('route 2 failed')
      if (angle.endsWith('分析')) return [hit(3)]
      return [hit(1), hit(2)]
    })
    const out = await runDeepSearch(cfg, '主题')
    expect(out.angles).toBe(3)
    expect(out.truncated).toBe(false)
    expect(out.results.map((r) => r.url)).toEqual([
      'https://site1.example.com/a',
      'https://site2.example.com/a',
      'https://site3.example.com/a'
    ])
    // 存活路的链接必须全部出现在模型可见文本里
    for (const url of out.results.map((r) => r.url)) {
      expect(out.text).toContain(url)
    }
  })

  it('三路都成功但 0 命中 → 纯文本空结果说明，不是空字符串', async () => {
    mockRunSearch.mockResolvedValue([])
    const out = await runDeepSearch(cfg, '主题')
    expect(out.results).toEqual([])
    expect(out.text).toBe('深度检索（3 路）：无搜索结果')
    expect(out.truncated).toBe(false)
  })

  it('全部失败 → 抛出第一条 rejection（不是静默空结果）', async () => {
    mockRunSearch.mockRejectedValue(new Error('所有路都失败'))
    await expect(runDeepSearch(cfg, '主题')).rejects.toThrow('所有路都失败')
  })

  it('正文抓取失败 → 保留 snippet，不把整次搜索判失败', async () => {
    mockRunSearch.mockResolvedValue([hit(1, { snippet: '原始摘要' })])
    mockSafeFetch.mockRejectedValueOnce(new Error('fetch failed'))
    const out = await runDeepSearch(cfg, '主题')
    expect(out.results).toHaveLength(1)
    expect(out.results[0]!.snippet).toBe('原始摘要')
    expect(out.results[0]!.content).toBeUndefined()
  })

  it('只补读前 3 条正文（≤1200），但模型只看到前 2 条正文', async () => {
    mockRunSearch.mockResolvedValue([
      hit(1, { url: 'https://a.example.com/1' }),
      hit(2, { url: 'https://b.example.com/2' }),
      hit(3, { url: 'https://c.example.com/3' }),
      hit(4, { url: 'https://d.example.com/4' }),
      hit(5, { url: 'https://e.example.com/5' })
    ])
    mockReadable.mockResolvedValue('长'.repeat(2000))
    const out = await runDeepSearch(cfg, '主题')

    expect(DEEP_TOP_BODIES).toBe(3)
    expect(mockSafeFetch).toHaveBeenCalledTimes(3)
    expect(mockSafeFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://a.example.com/1',
      'https://b.example.com/2',
      'https://c.example.com/3'
    ])
    expect(out.results[0]!.content!.length).toBe(DEEP_BODY_MAX_CHARS + 1)
    expect(out.results[0]!.content!.endsWith('…')).toBe(true)
    expect(out.results[3]!.content).toBeUndefined()
    expect(out.text.match(/正文：/g)).toHaveLength(DEEP_RENDER_BODY_ITEMS)
  })

  it('6 条接近上限（每条 300 字摘要 + 1200 正文）→ text <2000、6 个 URL 全在、正文仅 2 条', async () => {
    mockRunSearch.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        title: `第${i + 1}条搜索结果标题`.padEnd(30, '标'),
        url: `https://s${i + 1}.example.com/article-${i + 1}`,
        snippet: '摘'.repeat(300)
      }))
    )
    mockReadable.mockResolvedValue('正'.repeat(1200))
    const out = await runDeepSearch(cfg, '主题')

    expect(out.results).toHaveLength(6)
    expect(out.text.length).toBeLessThan(2000)
    expect(out.text.length).toBeLessThanOrEqual(DEEP_TEXT_MAX_CHARS)
    for (let i = 1; i <= 6; i++) {
      expect(out.text).toContain(`https://s${i}.example.com/article-${i}`)
      expect(out.text).toContain(`[${i}] `)
    }
    expect(out.text.match(/正文：/g)).toHaveLength(2)
    // 纯文本清单：不再有 JSON 片段
    expect(out.text).not.toContain('{"')
    expect(() => JSON.parse(out.text)).toThrow()
  })

  it('正文抓取带 10s 超时与 1MB 字节上限', async () => {
    mockRunSearch.mockResolvedValue([hit(1)])
    await runDeepSearch(cfg, '主题')
    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://site1.example.com/a',
      expect.objectContaining({ timeoutMs: 10_000, maxBytes: 1 * 1024 * 1024 })
    )
  })

  it('单路 15s 超时：路由被中止，整体按路失败处理', async () => {
    vi.useFakeTimers()
    mockRunSearch.mockImplementation(
      (_cfg, _query, _count, signal) =>
        new Promise<SearchHit[]>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const p = runDeepSearch(cfg, '主题')
    p.catch(() => { /* 断言前先挂住，避免未处理 rejection */ })
    await vi.advanceTimersByTimeAsync(DEEP_ROUTE_TIMEOUT_MS)
    await expect(p).rejects.toThrow('15s')
  })

  it('整体 30s 预算：即使 provider 忽略单路信号，超预算后仍中止', async () => {
    vi.useFakeTimers()
    mockRunSearch.mockImplementation(
      () => new Promise<SearchHit[]>((resolve) => setTimeout(() => resolve([]), 40_000))
    )
    const p = runDeepSearch(cfg, '主题')
    p.catch(() => { /* 同上 */ })
    await vi.advanceTimersByTimeAsync(DEEP_TOTAL_BUDGET_MS)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(p).rejects.toThrow('30s')
  })

  it('外部 abort → 原样上抛中止原因', async () => {
    const ctrl = new AbortController()
    ctrl.abort(new Error('用户停止'))
    mockRunSearch.mockImplementation((_cfg, _query, _count, signal) =>
      Promise.reject(signal?.reason ?? new Error('aborted'))
    )
    await expect(runDeepSearch(cfg, '主题', undefined, ctrl.signal)).rejects.toThrow('用户停止')
  })

  it('空 query → 直接报错，不发任何检索', async () => {
    await expect(runDeepSearch(cfg, '   ')).rejects.toThrow('query 不能为空')
    expect(mockRunSearch).not.toHaveBeenCalled()
  })

  it('每路固定带 count（缺省 5）与路由 signal', async () => {
    mockRunSearch.mockResolvedValue([])
    await runDeepSearch(cfg, '主题')
    expect(mockRunSearch).toHaveBeenCalledTimes(3)
    for (const call of mockRunSearch.mock.calls) {
      expect(call[2]).toBe(5)
      expect(call[3]).toBeInstanceOf(AbortSignal)
    }
  })
})
