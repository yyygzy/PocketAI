// SearXNG 搜索 provider（零 Key；地址由用户显式配置，不内置任何公共实例）
//
// GET {base}/search?q=<query>&format=json
// 响应 results[]：{ title, url, content, publishedDate?, engine? }
//
// 私网边界：guardHost=true + allowPrivateOrigin 仅在用户显式确认后才等于该地址的
// 精确 origin；默认仍由 provider-fetch 拒绝本机/内网地址。
import { providerFetchJson } from '../provider-fetch'
import type { RawSearchHit, SearchProvider } from '../types'

interface SearxngItem {
  title?: unknown
  url?: unknown
  content?: unknown
}

interface SearxngResponse {
  results?: SearxngItem[]
}

const TIMEOUT_MS = 15_000

export const searxngProvider: SearchProvider = {
  id: 'searxng',
  requiresKey: false,
  async search({ query, baseUrl, allowPrivateOrigin, signal }) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!base) throw new Error('未配置 SearXNG 实例地址，请在 Agent 页填写')
    const searchUrl = `${base}/search?q=${encodeURIComponent(query)}&format=json`

    const json = await providerFetchJson<SearxngResponse>(searchUrl, {
      headers: { Accept: 'application/json' },
      signal,
      timeoutMs: TIMEOUT_MS,
      guardHost: true,
      allowPrivateOrigin
    })
    if (!json || typeof json !== 'object') throw new Error('搜索响应解析失败')
    const items = Array.isArray(json.results) ? json.results : []
    return items.map<RawSearchHit>((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content
    }))
  }
}
