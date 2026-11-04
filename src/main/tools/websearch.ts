// web_search 工具的执行入口：读配置 → quick 交给可插拔搜索 registry / deep 交给有界编排
//
// 具体 provider（Tavily/博查/SearXNG）、归一化、限幅、错误分档都在 main/search 下，
// 本文件只保留「是否启用」「默认深度」这两层语义与对 builtin 的错误契约。
import { getWebSearchSecret } from './websearch-config'
import { runSearch } from '../search/registry'
import { runDeepSearch } from '../search/deep'
import type { DeepSearchOutcome } from '../search/deep'
import type { SearchHit } from '../search/types'
import type { WebSearchDepth } from '../../shared/types'

export type WebSearchHit = SearchHit
/** quick 返回命中数组；deep 返回带纯文本清单（text）的结果对象（builtin 直接回 text） */
export type WebSearchOutcome = WebSearchHit[] | DeepSearchOutcome

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
  signal?: AbortSignal,
  depth?: WebSearchDepth
): Promise<WebSearchOutcome> {
  const cfg = getWebSearchSecret()
  if (!cfg.enabled) throw new WebSearchDisabledError()
  const runtime = {
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    searxngBaseUrl: cfg.searxngBaseUrl,
    searxngAllowPrivate: cfg.searxngAllowPrivate
  }
  // 模型没点名 depth 时跟随 UI 里保存的档位：
  // - auto（默认）：不干预，模型传 deep 就 deep，缺省按 schema 默认 quick；
  // - quick/deep：强制覆盖模型的选择（统一在这一层判定，provider 不再各判一次）。
  const resolved: WebSearchDepth =
    cfg.depth === 'auto' ? (depth === 'deep' ? 'deep' : 'quick') : cfg.depth
  if (resolved === 'deep') return runDeepSearch(runtime, query, count, signal)
  return runSearch(runtime, query, count, signal)
}
