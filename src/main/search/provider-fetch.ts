// 搜索 provider 的统一出网层
//
// 出网统一走 safeFetch（DNS 校验 + IP pinning + 逐跳重定向校验 + 流式字节上限）：
// - 固定服务商端点（Tavily/博查）打开 useProxy，配置了 Clash/V2Ray 的用户仍可出网；
// - 用户可控地址（SearXNG）额外做 host 预检：默认拒绝私网/环回，只有
//   allowPrivateOrigin 与请求 URL 的 origin 精确一致时才放行；
// - 全程 maxRedirects:0（3xx 直接拒绝，防止 Key 被转发）、总超时、响应体字节上限。
import dns from 'node:dns'
import net from 'node:net'
import { safeFetch, SafeFetchError, isDisallowedIp, isPrivateHostname } from '../net/safe-fetch'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

export interface ProviderFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  /** 用户可控 host（SearXNG）时启用私网预检；固定服务商端点保持 false */
  guardHost?: boolean
  /** 仅放行这一个精确 origin（协议+主机+端口）的私网访问 */
  allowPrivateOrigin?: string
}

/** provider 层的 HTTP 失败（带状态码，供 registry 分档翻译） */
export class ProviderFetchError extends Error {
  readonly status?: number
  readonly bodyText?: string

  constructor(message: string, status?: number, bodyText?: string) {
    super(message)
    this.name = 'ProviderFetchError'
    this.status = status
    this.bodyText = bodyText
  }
}

/** 截断错误响应片段（不透传请求体，避免 Key 出现在错误里） */
function cut(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * SearXNG 地址的主机预检（纯校验，不做网络请求；lookup 可注入便于测试）。
 * - origin 精确匹配 allowPrivateOrigin ⇒ 直接放行；
 * - 字面私网/环回/内网后缀 ⇒ 拒绝；
 * - 域名解析全部落在私网 ⇒ 拒绝。
 */
export async function assertProviderHostAllowed(
  u: URL,
  allowPrivateOrigin?: string,
  lookup: typeof dns.promises.lookup = dns.promises.lookup
): Promise<void> {
  if (allowPrivateOrigin && u.origin === allowPrivateOrigin) return
  const raw = u.hostname.toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (isPrivateHostname(host)) {
    throw new ProviderFetchError(`禁止访问内网主机: ${host}（如为自建 SearXNG，请显式允许该地址）`)
  }
  if (net.isIP(host)) return
  let list: { address: string }[]
  try {
    const resolved = await lookup(host, { all: true, verbatim: true })
    list = Array.isArray(resolved) ? resolved : [resolved]
  } catch {
    throw new ProviderFetchError(`域名解析失败: ${host}`)
  }
  if (list.length === 0) throw new ProviderFetchError(`域名解析失败: ${host}`)
  if (list.every((a) => isDisallowedIp(a.address))) {
    throw new ProviderFetchError(`目标解析到内网/保留地址，已拦截: ${host}`)
  }
}

/** 发起请求并解析 JSON；3xx/非 2xx/无效 JSON 均抛 ProviderFetchError */
export async function providerFetchJson<T>(
  rawUrl: string,
  opts: ProviderFetchOptions = {}
): Promise<T> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new ProviderFetchError(`URL 无效: ${rawUrl}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ProviderFetchError(`仅支持 http/https 协议: ${u.protocol}`)
  }
  if (opts.guardHost) await assertProviderHostAllowed(u, opts.allowPrivateOrigin)

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onAbort = (): void => ctrl.abort()
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  let res: { status: number; body: Buffer }
  try {
    res = await safeFetch(u.toString(), {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
      timeoutMs,
      maxBytes,
      // 等价于原来的 redirect:'manual'：任何 3xx 都拒绝，不跟随、不转发 Key
      maxRedirects: 0,
      useProxy: true,
      allowPrivateOrigin: opts.guardHost ? opts.allowPrivateOrigin : undefined
    })
  } catch (e) {
    if (timedOut) throw new ProviderFetchError(`搜索请求超时（${timeoutMs / 1000}s）`)
    if (opts.signal?.aborted) throw new ProviderFetchError('已中止')
    if (e instanceof SafeFetchError && /重定向次数超限/.test(e.message)) {
      throw new ProviderFetchError('搜索服务返回重定向，已拒绝跟随（防止 API Key 泄漏）')
    }
    throw new ProviderFetchError(e instanceof Error ? e.message : '搜索请求失败')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }

  const status = res.status
  // safeFetch 在 maxRedirects:0 下遇到 3xx 已抛错；这里保留兜底，防御未来改动
  if (status >= 300 && status < 400) {
    throw new ProviderFetchError('搜索服务返回重定向，已拒绝跟随（防止 API Key 泄漏）', status)
  }
  const text = res.body.toString('utf8')
  if (status < 200 || status >= 300) {
    throw new ProviderFetchError(`搜索失败 HTTP ${status}`, status, cut(text, 200))
  }
  try {
    return JSON.parse(text || 'null') as T
  } catch {
    throw new ProviderFetchError('搜索服务返回了无效的 JSON 响应', status)
  }
}
