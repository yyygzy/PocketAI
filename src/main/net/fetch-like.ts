// 把统一出网闸 safeFetch 适配成 fetch(RequestInit) 形态，供仍以 fetchImpl 注入的
// OAuth 发现/令牌调用点使用（M10）：逐跳 DNS 校验 + IP pinning + 禁止重定向 + 有界响应体。
import { safeFetch } from './safe-fetch'

function normalizeHeaders(init?: RequestInit): Record<string, string> | undefined {
  const h = init?.headers
  if (!h) return undefined
  if (typeof Headers !== 'undefined' && h instanceof Headers) return Object.fromEntries(h.entries())
  if (Array.isArray(h)) return Object.fromEntries(h)
  return h as Record<string, string>
}

export async function safeFetchLike(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const rawBody = init?.body
  const body = typeof rawBody === 'string'
    ? rawBody
    : Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : undefined
  const res = await safeFetch(String(input), {
    method: init?.method ?? 'GET',
    headers: normalizeHeaders(init),
    body,
    signal: init?.signal ?? undefined,
    maxRedirects: 0,
    maxBytes: 1024 * 1024,
    useProxy: true
  })
  return new Response(res.body as unknown as BodyInit, { status: res.status, headers: res.headers })
}
