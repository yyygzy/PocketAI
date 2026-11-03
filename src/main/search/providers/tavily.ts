// Tavily 搜索 provider：POST https://api.tavily.com/search
// body { api_key, query, max_results }；响应 results[]
import { providerFetchJson } from '../provider-fetch'
import type { RawSearchHit, SearchProvider } from '../types'

interface TavilyItem {
  title?: unknown
  url?: unknown
  content?: unknown
  snippet?: unknown
}

interface TavilyResponse {
  results?: TavilyItem[]
}

export const tavilyProvider: SearchProvider = {
  id: 'tavily',
  requiresKey: true,
  async search({ query, count, apiKey, signal }) {
    const json = await providerFetchJson<TavilyResponse>('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: count }),
      signal,
      timeoutMs: 15_000
    })
    if (!json || typeof json !== 'object') throw new Error('搜索响应解析失败')
    const items = Array.isArray(json.results) ? json.results : []
    return items.map<RawSearchHit>((r) => ({
      title: r.title,
      url: r.url,
      // Tavily 主字段是 content，少数兼容响应给 snippet
      snippet: r.content ?? r.snippet
    }))
  }
}
