// web_search 工具的执行入口：读配置 → 交给可插拔搜索 registry
//
// 具体 provider（Tavily/博查/SearXNG）、归一化、限幅、错误分档都在 main/search 下，
// 本文件只保留「是否启用」这一层语义与对 builtin 的错误契约。
import { getWebSearchSecret } from './websearch-config'
import { runSearch } from '../search/registry'
import type { SearchHit } from '../search/types'

export type WebSearchHit = SearchHit

/** 未启用是「可引导」状态，不是失败：builtin 会把它转成结构化提示 */
export class WebSearchDisabledError extends Error {
  readonly code = 'WEB_SEARCH_DISABLED'

  constructor() {
    super('联网搜索当前未启用')
    this.name = 'WebSearchDisabledError'
  }
}

export async function runWebSearch(
  query: string,
  count?: number,
  signal?: AbortSignal
): Promise<WebSearchHit[]> {
  const cfg = getWebSearchSecret()
  if (!cfg.enabled) throw new WebSearchDisabledError()
  return runSearch(
    {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      searxngBaseUrl: cfg.searxngBaseUrl,
      searxngAllowPrivate: cfg.searxngAllowPrivate
    },
    query,
    count,
    signal
  )
}
