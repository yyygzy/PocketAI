// 联网搜索服务（v2 批次六：web.search 工具的真实现）
//
// 服务商与请求方式（各自按官方文档）：
//  - Tavily：POST https://api.tavily.com/search          body { api_key, query, max_results }
//  - 博查  ：POST https://api.bochaai.com/v1/web-search   Bearer + body { query, count, summary }
//
// 归一化输出：紧凑 JSON 数组 [{title, url, snippet}]，snippet ≤400 字符（引擎层另有 2000 字符兜底）。
// 出站域名仅以上两个固定端点；query/count 均做白名单校验。
// 安全：统一走 safeFetch（SSRF 防护 + 响应体 5MB 上限 + 全程超时 + abort）；
//       maxRedirects=0 禁止跟随重定向，避免 API Key / Bearer 被转发到 Location 第三方主机。
import { getWebSearchSecret } from './websearch-config'
import { safeFetch } from '../net/safe-fetch'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_COUNT = 8
const DEFAULT_COUNT = 5
const MAX_SNIPPET_CHARS = 400
/** 搜索响应体上限（5MB），防止被劫持/故障服务商返回巨型响应打爆内存 */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

// 两家搜索 API 响应（仅用到字段；外部边界，全部可选并在取用处收窄）
interface TavilyItem {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
}
interface BochaItem {
  name?: unknown
  url?: unknown
  snippet?: unknown
  summary?: unknown
}
interface SearchApiResponse {
  results?: TavilyItem[]
  data?: { webPages?: { value?: BochaItem[] } }
}

/** 摘要截断 */
function cut(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 发起联网搜索，返回归一化结果（供 builtin.ts 的 web_search 工具调用） */
export async function runWebSearch(
  query: string,
  count?: number,
  signal?: AbortSignal
): Promise<WebSearchHit[]> {
  const { enabled, provider, apiKey } = getWebSearchSecret()
  if (!enabled) throw new Error('联网搜索未启用，请在 Agent 页「联网搜索」卡片中开启')
  if (!apiKey) throw new Error('未配置搜索 API Key，请在 Agent 页填写')

  const q = cut(query, 500)
  if (!q) throw new Error('query 不能为空')
  const rawN = Number(count)
  const n = Math.min(
    Math.max(Math.floor(rawN > 0 && Number.isFinite(rawN) ? rawN : DEFAULT_COUNT), 1),
    MAX_COUNT
  )

  // 用户中止（Agent 停止）与 15s 超时由 safeFetch 内部 deadline 统一控制；
  // 外部 signal 透传给 safeFetch，中止时销毁底层连接。
  let result
  if (provider === 'tavily') {
    result = await safeFetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: q, max_results: n }),
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      // 禁止跟随重定向，避免请求体中的 api_key 被转发到 Location 第三方主机
      maxRedirects: 0
    })
  } else {
    result = await safeFetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: q, count: n, summary: true }),
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      // 禁止跟随重定向，避免 Bearer Key 被发送到第三方主机
      maxRedirects: 0
    })
  }

  if (result.status >= 300 && result.status < 400) {
    throw new Error('搜索服务返回重定向，已拒绝跟随（防止 API Key 泄漏）')
  }

  if (result.status < 200 || result.status >= 300) {
    const text = result.body.toString('utf-8')
    // 不透传请求体（内含 Key），只透传响应片段
    throw new Error(`搜索失败 HTTP ${result.status}: ${cut(text, 200)}`)
  }

  const json = JSON.parse(result.body.toString('utf-8') || 'null') as SearchApiResponse | null
  if (json === null) throw new Error('搜索响应解析失败')

  const hits: WebSearchHit[] =
    provider === 'tavily'
      ? (Array.isArray(json.results) ? json.results : []).map((r) => ({
          title: cut(r.title, 200),
          url: String(r.url ?? ''),
          snippet: cut(r.content ?? r.snippet, MAX_SNIPPET_CHARS)
        }))
      : // 博查：data.webPages.value[]
        (json.data?.webPages?.value ?? []).map((r) => ({
          title: cut(r.name, 200),
          url: String(r.url ?? ''),
          snippet: cut(r.snippet ?? r.summary, MAX_SNIPPET_CHARS)
        }))

  return hits.filter((h) => h.title && h.url)
}
