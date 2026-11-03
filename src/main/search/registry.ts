// 搜索 provider 注册表：选择 provider、请求参数限幅、结果归一化与错误分档
//
// 归一化、限幅、过滤、去重**只在这里做一次**；各 provider 只把自家响应
// 拆成 RawSearchHit[]，不重复实现截断规则。
import { isPrivateHostname } from '../net/safe-fetch'
import { ProviderFetchError } from './provider-fetch'
import { bochaProvider } from './providers/bocha'
import { searxngProvider } from './providers/searxng'
import { tavilyProvider } from './providers/tavily'
import type { RawSearchHit, SearchHit, SearchProvider, SearchRuntimeConfig } from './types'
import type { WebSearchProvider } from '../../shared/types'

const MAX_QUERY_CHARS = 500
const MAX_TITLE_CHARS = 200
const MAX_SNIPPET_CHARS = 400
const MAX_COUNT = 8
const DEFAULT_COUNT = 5

const PROVIDERS: Record<WebSearchProvider, SearchProvider> = {
  tavily: tavilyProvider,
  bocha: bochaProvider,
  searxng: searxngProvider
}

/** 摘要/标题截断（与原实现同口径：超长时追加 …） */
function cut(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 搜索词归一化：压缩空白 + ≤500 字符 */
export function normalizeSearchQuery(raw: string): string {
  return cut(raw, MAX_QUERY_CHARS)
}

/** 条数限幅：0/负数/NaN → 5；超过 8 → 8；小数向下取整 */
export function normalizeSearchCount(raw: unknown): number {
  const n = Number(raw)
  const base = n > 0 && Number.isFinite(n) ? Math.floor(n) : DEFAULT_COUNT
  return Math.min(Math.max(base, 1), MAX_COUNT)
}

/** URL 归一化（去 fragment / 常见跟踪参数 / 尾斜杠），用于跨 provider 去重 */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const key of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'mc_cid',
      'mc_eid',
      'spm'
    ]) {
      u.searchParams.delete(key)
    }
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString()
  } catch {
    return raw
  }
}

/** 原始条目 → 归一化结果：字段截断、空值过滤、http(s) 协议过滤、URL 去重、条数封顶 */
export function normalizeSearchHits(raw: RawSearchHit[], limit: number): SearchHit[] {
  const out: SearchHit[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const title = cut(item.title, MAX_TITLE_CHARS)
    const url = String(item.url ?? '').trim()
    if (!title || !url) continue
    if (!/^https?:\/\//i.test(url)) continue
    const key = canonicalUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    // 返回归一化后的 URL（去掉 utm/fbclid/尾斜杠等），引用展示与去重口径一致
    out.push({ title, url: key, snippet: cut(item.snippet, MAX_SNIPPET_CHARS) })
    if (out.length >= limit) break
  }
  return out
}

/** SearXNG 私网地址未确认时的统一提示（provider-fetch 的预检是最后一道闸） */
function assertSearxngPrivateAllowed(cfg: SearchRuntimeConfig): string | undefined {
  const base = cfg.searxngBaseUrl.trim()
  if (!base) throw new Error('未配置 SearXNG 实例地址，请在 Agent 页填写（需自建或可信实例）')
  let u: URL
  try {
    u = new URL(base)
  } catch {
    throw new Error('SearXNG 实例地址无效，请在 Agent 页重新填写')
  }
  if (isPrivateHostname(u.hostname)) {
    if (!cfg.searxngAllowPrivate) {
      throw new Error('该 SearXNG 地址属于本机/内网，需在配置中勾选「允许访问本机/内网地址」并确认风险')
    }
    return u.origin
  }
  return undefined
}

/** provider 错误 → 面向模型/用户的分档文案（401/403 与 429 分开） */
export function describeSearchError(e: unknown, provider: WebSearchProvider): Error {
  // 仅对真正的非 2xx 分档；200 的无效 JSON / 超时等保留原错误文案
  if (e instanceof ProviderFetchError && e.status !== undefined && (e.status < 200 || e.status >= 300)) {
    const s = e.status
    if (s === 401 || s === 403) {
      if (provider === 'searxng') {
        return new Error(
          `SearXNG 拒绝访问（HTTP ${s}）：请检查实例地址、是否已开启 JSON 输出（format=json）及访问权限`
        )
      }
      return new Error(`搜索服务鉴权失败（HTTP ${s}）：请检查 API Key 是否正确`)
    }
    if (s === 429) {
      return new Error('搜索服务限流（HTTP 429）：请稍后再试，或更换服务商/实例')
    }
    if (s >= 500) {
      return new Error(`搜索服务暂时不可用（HTTP ${s}）：请稍后再试`)
    }
    return new Error(`搜索失败 HTTP ${s}${e.bodyText ? `: ${e.bodyText}` : ''}`)
  }
  return e instanceof Error ? e : new Error('搜索失败')
}

export function getSearchProvider(id: WebSearchProvider): SearchProvider {
  return PROVIDERS[id] ?? tavilyProvider
}

/**
 * 执行一次联网搜索。
 * 入参 query/count 会在此统一限幅；provider 返回的条目也在此统一归一化。
 */
export async function runSearch(
  cfg: SearchRuntimeConfig,
  query: string,
  count?: number,
  signal?: AbortSignal
): Promise<SearchHit[]> {
  const q = normalizeSearchQuery(query)
  if (!q) throw new Error('query 不能为空')
  const n = normalizeSearchCount(count)
  const provider = getSearchProvider(cfg.provider)

  if (provider.requiresKey && !cfg.apiKey) {
    throw new Error('未配置搜索 API Key，请在 Agent 输入框「+」→「工具配置」中填写')
  }
  const allowPrivateOrigin =
    cfg.provider === 'searxng' ? assertSearxngPrivateAllowed(cfg) : undefined

  let raw: RawSearchHit[]
  try {
    raw = await provider.search({
      query: q,
      count: n,
      apiKey: cfg.apiKey,
      baseUrl: cfg.searxngBaseUrl,
      allowPrivateOrigin,
      signal
    })
  } catch (e) {
    throw describeSearchError(e, cfg.provider)
  }
  return normalizeSearchHits(raw, n)
}
