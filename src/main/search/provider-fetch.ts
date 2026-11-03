// 搜索 provider 的统一出网层
//
// 与 safeFetch 的分工：
// - 固定服务商端点（Tavily/博查）走**全局 fetch**（main/net/proxy.ts 已把它替换为
//   proxy 感知的 undici fetch），因此配置了 Clash/V2Ray 的用户可正常出网；
// - 用户可控地址（SearXNG）额外做 host 预检：默认拒绝私网/环回，只有
//   allowPrivateOrigin 与请求 URL 的 origin 精确一致时才放行；
// - 全程 redirect:'manual'（3xx 直接拒绝，防止 Key 被转发）、总超时、响应体字节上限。
import dns from 'node:dns'
import net from 'node:net'
import { isDisallowedIp, isPrivateHostname } from '../net/safe-fetch'

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

/** 流式读体并强制字节上限 */
async function readBodyLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderFetchError(`搜索响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
  }
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new ProviderFetchError(`搜索响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
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

  let res: Response
  try {
    res = await globalThis.fetch(u.toString(), {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: ctrl.signal
    })
  } catch (e) {
    if (timedOut) throw new ProviderFetchError(`搜索请求超时（${timeoutMs / 1000}s）`)
    if (opts.signal?.aborted) throw new ProviderFetchError('已中止')
    throw new ProviderFetchError(e instanceof Error ? e.message : '搜索请求失败')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }

  const status = res.status
  if (status >= 300 && status < 400) {
    throw new ProviderFetchError('搜索服务返回重定向，已拒绝跟随（防止 API Key 泄漏）', status)
  }
  let text: string
  try {
    text = await readBodyLimited(res, maxBytes)
  } catch (e) {
    if (timedOut) throw new ProviderFetchError(`搜索请求超时（${timeoutMs / 1000}s）`)
    throw e
  }
  if (status < 200 || status >= 300) {
    throw new ProviderFetchError(`搜索失败 HTTP ${status}`, status, cut(text, 200))
  }
  try {
    return JSON.parse(text || 'null') as T
  } catch {
    throw new ProviderFetchError('搜索服务返回了无效的 JSON 响应', status)
  }
}
