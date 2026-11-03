// 博查（Bocha）搜索 provider：POST https://api.bochaai.com/v1/web-search
// Bearer + body { query, count, summary }；响应 data.webPages.value[]
import { providerFetchJson } from '../provider-fetch'
import type { RawSearchHit, SearchProvider } from '../types'

interface BochaItem {
  name?: unknown
  url?: unknown
  snippet?: unknown
  summary?: unknown
}

interface BochaResponse {
  data?: { webPages?: { value?: BochaItem[] } }
}

export const bochaProvider: SearchProvider = {
  id: 'bocha',
  requiresKey: true,
  async search({ query, count, apiKey, signal }) {
    const json = await providerFetchJson<BochaResponse>('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, count, summary: true }),
      signal,
      timeoutMs: 15_000
    })
    if (!json || typeof json !== 'object') throw new Error('搜索响应解析失败')
    const items = json.data?.webPages?.value ?? []
    return items.map<RawSearchHit>((r) => ({
      title: r.name,
      url: r.url,
      snippet: r.snippet ?? r.summary
    }))
  }
}
