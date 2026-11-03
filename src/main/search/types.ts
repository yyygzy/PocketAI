// 可插拔搜索 provider 的类型契约
//
// 设计约定：
// - provider 只负责「发请求 + 把自家响应拆成原始字段」；
// - 归一化（title/snippet 截断、空值过滤、URL 去重、count 限幅）统一在 registry，
//   避免每家 provider 各写一遍导致口径漂移。
import type { WebSearchProvider } from '../../shared/types'

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

/** provider 返回的未归一化条目（外部边界，字段全部 unknown） */
export interface RawSearchHit {
  title?: unknown
  url?: unknown
  snippet?: unknown
}

export interface ProviderSearchInput {
  /** 已由 registry 归一化：去首尾空白、≤500 字符 */
  query: string
  /** 已由 registry 限幅：1–8 */
  count: number
  apiKey: string
  /** SearXNG 实例基地址；其它 provider 忽略 */
  baseUrl?: string
  /** 仅 SearXNG：用户显式确认后允许的精确 origin（其它 provider 不传） */
  allowPrivateOrigin?: string
  signal?: AbortSignal
}

export interface SearchProvider {
  id: WebSearchProvider
  requiresKey: boolean
  search(input: ProviderSearchInput): Promise<RawSearchHit[]>
}

/** registry 运行所需的最小配置快照（由 websearch-config 提供） */
export interface SearchRuntimeConfig {
  provider: WebSearchProvider
  apiKey: string
  searxngBaseUrl: string
  searxngAllowPrivate: boolean
}
