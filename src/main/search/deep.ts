// deep 搜索编排：全部有界，单路失败不拖垮整体
//
// 流程（最多 3 路并行 → 归一化去重 → 同域限量 → 前 3 条补读正文 → 文本清单渲染）：
//   1. 角度扩展不额外调 LLM：原 query + 2 个启发式变体，共 ≤3 路
//   2. Promise.allSettled 并行，单路 15s（provider 层已带超时），整体 30s 预算
//   3. URL 归一化去重（canonicalUrl：小写 host、去追踪参数/锚点/尾斜杠），同域最多 2 条
//   4. 仅前 3 条唯一 URL 补读正文（10s、1MB），失败保留 snippet
//   5. 输出 ≤6 条，模型可见为**纯文本编号清单**（[n] 标题 — URL + 摘要，正文只给前 2 条×300 字），
//      最终文本 ≤1900 字符（含清单头/尾注）—— 正常 6 条场景不会触发引擎的 2000 字压缩层
//
// 正文补读走 safeFetch（逐跳 SSRF 校验），不是搜服务商那条代理感知 fetch：
// 搜索结果里的链接是外部内容，不能因为「搜索走了代理」就把任意 URL 的抓取也放出去。
import { safeFetch } from '../net/safe-fetch'
import { extractReadableText, extractTitle } from '../net/readable'
import { canonicalUrl, runSearch } from './registry'
import type { SearchHit, SearchRuntimeConfig } from './types'

export const DEEP_MAX_ANGLES = 3
export const DEEP_PER_ANGLE_COUNT = 5
export const DEEP_ROUTE_TIMEOUT_MS = 15_000
export const DEEP_TOTAL_BUDGET_MS = 30_000
export const DEEP_BODY_TIMEOUT_MS = 10_000
export const DEEP_BODY_MAX_BYTES = 1 * 1024 * 1024
export const DEEP_BODY_MAX_CHARS = 1200
export const DEEP_MAX_RESULTS = 6
export const DEEP_MAX_PER_DOMAIN = 2
export const DEEP_TOP_BODIES = 3
/**
 * 最终交给模型的文本总上限（含清单头与尾注）。
 * 为什么是 1900 而不是 8000：引擎对超 2000 字符的工具结果会做结构化压缩，8000 的 JSON 信封
 * 在那一层会被切成只剩 1 条链接的残片；文本清单天然短，只要守住 2000 以下就不会被压缩。
 * 兜底按**最终渲染文本**计长（不是中间结构），且骨架（标题+URL）永不丢弃。
 */
export const DEEP_TEXT_MAX_CHARS = 1900
/** 单条正文展示上限（补读阶段先截到 1200，这里再按 300 字给模型） */
export const DEEP_RENDER_BODY_CHARS = 300
/** 最多给前几条带正文，其余只给摘要 */
export const DEEP_RENDER_BODY_ITEMS = 2
/** 单条摘要展示上限 */
export const DEEP_SNIPPET_MAX_CHARS = 80

export interface DeepSearchHit extends SearchHit {
  /** 补读到的正文（≤1200 字符）；抓取失败时缺省，保留 snippet */
  content?: string
}

export interface DeepSearchOutcome {
  depth: 'deep'
  query: string
  results: DeepSearchHit[]
  /** 模型可见的纯文本编号清单（唯一输出形态，不再有 JSON 信封） */
  text: string
  /** 实际发出的检索路数（1–3） */
  angles: number
  /**
   * 最终文本是否被削过：true 当且仅当 text 里的摘要/正文被按上限截短或为控长被省略
   * （包括极端长 URL 时退到只剩骨架）。不再出现「实际超限却 false」的口径。
   */
  truncated: boolean
}

/** 角度扩展：原 query + 2 个启发式变体；去重后仍最多 3 路 */
export function buildSearchAngles(query: string): string[] {
  const q = query.trim()
  if (!q) return []
  const angles = [q, `${q} 最新`, `${q} 分析`]
  return [...new Set(angles)].slice(0, DEEP_MAX_ANGLES)
}

/** 跨路合并后的筛选：URL 归一化去重 + 同域最多 2 条 + 总数封顶 */
export function selectDeepHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const perDomain = new Map<string, number>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    const url = canonicalUrl(hit.url)
    if (!url || seen.has(url)) continue
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }
    const used = perDomain.get(host) ?? 0
    if (used >= DEEP_MAX_PER_DOMAIN) continue
    seen.add(url)
    perDomain.set(host, used + 1)
    out.push({ ...hit, url })
    if (out.length >= DEEP_MAX_RESULTS) break
  }
  return out
}

/** 渲染档位：从完整展示逐级收紧到只有骨架，保证最终文本不越过 DEEP_TEXT_MAX_CHARS */
interface DeepRenderPlan {
  bodyChars: number
  snippetChars: number
  titleChars: number
}

/**
 * 降级顺序：先压正文（300→150），再压摘要（80→60→40），最后只留骨架。
 * 不靠抬总长阈值解决，也不按中间 JSON 结构估算——每一档都按**最终渲染文本**计长。
 */
const DEEP_RENDER_PLANS: readonly DeepRenderPlan[] = [
  { bodyChars: DEEP_RENDER_BODY_CHARS, snippetChars: DEEP_SNIPPET_MAX_CHARS, titleChars: 60 },
  { bodyChars: DEEP_RENDER_BODY_CHARS, snippetChars: 60, titleChars: 50 },
  { bodyChars: 150, snippetChars: 60, titleChars: 40 },
  { bodyChars: 150, snippetChars: 40, titleChars: 40 },
  { bodyChars: 0, snippetChars: 0, titleChars: 40 }
]

const DEEP_TRUNCATION_NOTE = '（说明：受长度限制，部分摘要/正文已省略；标题与链接完整）'

interface RenderedDeepText {
  text: string
  truncated: boolean
}

/** 摘要/正文可能带换行，压成一行，既省字符又让清单可解析 */
function compactLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clipLine(text: string, maxChars: number): { text: string; cut: boolean } {
  const s = compactLine(text)
  if (s.length <= maxChars) return { text: s, cut: false }
  return { text: s.slice(0, maxChars) + '…', cut: true }
}

function renderDeepTextOnce(
  results: DeepSearchHit[],
  angles: number,
  plan: DeepRenderPlan
): RenderedDeepText {
  // 正文只给前 N 条**有正文**的结果；其余只给摘要
  const bodyIdx = new Set<number>()
  for (let i = 0; i < results.length && bodyIdx.size < DEEP_RENDER_BODY_ITEMS; i++) {
    if (results[i]!.content) bodyIdx.add(i)
  }
  const bodyCount = plan.bodyChars > 0 ? bodyIdx.size : 0

  const lines: string[] = []
  let truncated = false
  let omittedBody = false
  let omittedSnippet = false

  lines.push(
    `深度检索（${angles} 路）：${results.length} 条结果` + (bodyCount > 0 ? `，正文 ${bodyCount} 条` : '')
  )

  results.forEach((hit, idx) => {
    const title = clipLine(hit.title || hit.url, plan.titleChars)
    if (title.cut) truncated = true
    lines.push(`[${idx + 1}] ${title.text} — ${hit.url}`)

    const snippet = hit.snippet ? compactLine(hit.snippet) : ''
    if (snippet) {
      if (plan.snippetChars > 0) {
        const clipped = clipLine(snippet, plan.snippetChars)
        if (clipped.cut) truncated = true
        if (clipped.text) lines.push(`摘要：${clipped.text}`)
      } else {
        omittedSnippet = true
      }
    }

    if (bodyIdx.has(idx) && hit.content) {
      if (plan.bodyChars > 0) {
        const clipped = clipLine(hit.content, plan.bodyChars)
        if (clipped.cut) truncated = true
        if (clipped.text) lines.push(`正文：${clipped.text}`)
      } else {
        omittedBody = true
      }
    }
  })

  // 尾注只在真的省略内容时出现，且它本身也计入预算
  if (omittedBody || omittedSnippet) {
    truncated = true
    lines.push(DEEP_TRUNCATION_NOTE)
  }

  return { text: lines.join('\n'), truncated }
}

/**
 * 把结果渲染成模型可见的纯文本清单，并在预算内逐级收紧。
 * 骨架（标题 + URL）是最后一道底线：即使单条 URL 极端长导致骨架本身超预算，
 * 也只保留骨架，绝不把整条丢掉——模型至少能看到 n 条标题与链接。
 */
export function renderDeepText(results: DeepSearchHit[], angles: number): RenderedDeepText {
  if (results.length === 0) {
    return { text: `深度检索（${angles} 路）：无搜索结果`, truncated: false }
  }
  let last: RenderedDeepText | null = null
  for (const plan of DEEP_RENDER_PLANS) {
    last = renderDeepTextOnce(results, angles, plan)
    if (last.text.length <= DEEP_TEXT_MAX_CHARS) return last
  }
  return { text: last!.text, truncated: true }
}

function cut(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

/** 把用户/引擎的 abort 信号与 30s 总预算合成一个信号，并返回清理函数 */
function linkAbort(signal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('deep 搜索超出 30s 预算')),
    DEEP_TOTAL_BUDGET_MS
  )
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('搜索已中止')
}

/** 单路 15s 上限：provider 层已带超时，这里再兜一道，防止某家实现忽略 signal */
function routeSignal(parent: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const route = new AbortController()
  const timer = setTimeout(
    () => route.abort(new Error('单路检索超出 15s')),
    DEEP_ROUTE_TIMEOUT_MS
  )
  const onAbort = (): void => route.abort(parent.reason)
  if (parent.aborted) route.abort(parent.reason)
  else parent.addEventListener('abort', onAbort, { once: true })
  return {
    signal: route.signal,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    }
  }
}

/** 补读单页正文：失败由调用方降级到 snippet */
async function fetchBody(
  url: string,
  signal: AbortSignal
): Promise<{ title: string; text: string }> {
  const res = await safeFetch(url, {
    signal,
    timeoutMs: DEEP_BODY_TIMEOUT_MS,
    maxBytes: DEEP_BODY_MAX_BYTES,
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
  })
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  const html = res.body.toString('utf8')
  return {
    title: extractTitle(html),
    text: await extractReadableText(html, DEEP_BODY_MAX_CHARS)
  }
}

export async function runDeepSearch(
  cfg: SearchRuntimeConfig,
  query: string,
  count?: number,
  signal?: AbortSignal
): Promise<DeepSearchOutcome> {
  const angles = buildSearchAngles(query)
  if (angles.length === 0) throw new Error('query 不能为空')

  const linked = linkAbort(signal)
  try {
    // 单路失败只丢这一路：allSettled 不因一路 reject 取消其余
    const settled = await Promise.allSettled(
      angles.map(async (angle) => {
        const route = routeSignal(linked.signal)
        try {
          return await runSearch(cfg, angle, count ?? DEEP_PER_ANGLE_COUNT, route.signal)
        } finally {
          route.dispose()
        }
      })
    )
    if (linked.signal.aborted) throw abortError(linked.signal)

    const hits: SearchHit[] = []
    for (const r of settled) {
      if (r.status === 'fulfilled') hits.push(...r.value)
    }
    if (hits.length === 0) {
      const rejected = settled.find((r) => r.status === 'rejected')
      if (rejected && rejected.status === 'rejected') throw rejected.reason
      return {
        depth: 'deep',
        query,
        results: [],
        angles: angles.length,
        truncated: false,
        text: `深度检索（${angles.length} 路）：无搜索结果`
      }
    }

    const selected = selectDeepHits(hits)
    const bodyTargets = selected.slice(0, DEEP_TOP_BODIES)
    // 正文抓取同样并行；失败保留 snippet，不把整次搜索判失败
    const bodies = await Promise.allSettled(
      bodyTargets.map((h) => fetchBody(h.url, linked.signal))
    )
    if (linked.signal.aborted) throw abortError(linked.signal)

    const merged: DeepSearchHit[] = selected.map((hit) => {
      const idx = bodyTargets.indexOf(hit)
      const body = idx >= 0 ? bodies[idx] : undefined
      if (body?.status === 'fulfilled' && body.value.text) {
        return { ...hit, content: cut(body.value.text, DEEP_BODY_MAX_CHARS) }
      }
      return { ...hit }
    })

    const rendered = renderDeepText(merged, angles.length)
    return {
      depth: 'deep',
      query,
      results: merged,
      angles: angles.length,
      truncated: rendered.truncated,
      text: rendered.text
    }
  } finally {
    linked.dispose()
  }
}
