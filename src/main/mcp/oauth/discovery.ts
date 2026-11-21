// OAuth 元数据发现（MCP 授权规范：Protected Resource Metadata + AS Metadata）。
//
// 只用远端服务公开的 well-known 文档，不猜测、不带凭据；所有 URL 都过 https/回环/私网闸门。
// 发现失败时由上层提示用户填写手动端点，不静默跳过授权。
import { oauthEndpointProblem } from '../../../shared/mcp-oauth'
import { errMsg, isAbortError } from '../../error'
import { readTextLimited } from '../../net/bounded-read'
import { safeFetchLike } from '../../net/fetch-like'

const DISCOVERY_TIMEOUT_MS = 8_000
const MAX_JSON_BYTES = 256 * 1024

export interface DiscoveredOauthConfig {
  issuer: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  scope: string | null
  source: 'well-known' | 'challenge' | 'manual'
}

interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<unknown> {
  const problem = oauthEndpointProblem(url, 'OAuth 元数据地址')
  if (problem) throw new Error(problem)
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    })
  } catch (e) {
    if (isAbortError(e)) throw new Error('读取 OAuth 元数据超时，请检查网络后重试。')
    throw new Error(`读取 OAuth 元数据失败：${errMsg(e)}`)
  }
  if (!res.ok) throw new Error(`OAuth 元数据请求失败（HTTP ${res.status}）`)
  const text = await readTextLimited(res, MAX_JSON_BYTES, 'OAuth 元数据')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('OAuth 元数据不是合法 JSON。')
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : []
}

function pickScope(v: unknown): string | null {
  const arr = stringArray(v)
  return arr.length ? arr.join(' ') : null
}

interface AsMetadata {
  issuer: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  scope: string | null
}

function parseAsMetadata(raw: unknown): AsMetadata {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const authorizationEndpoint = str(o.authorization_endpoint)
  const tokenEndpoint = str(o.token_endpoint)
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('授权服务器元数据缺少 authorization_endpoint / token_endpoint。')
  }
  const issuer = str(o.issuer)
  const registrationEndpoint = str(o.registration_endpoint)
  const revocationEndpoint = str(o.revocation_endpoint)
  for (const [value, label] of [
    [authorizationEndpoint, 'authorization_endpoint'],
    [tokenEndpoint, 'token_endpoint'],
    [registrationEndpoint, 'registration_endpoint'],
    [revocationEndpoint, 'revocation_endpoint']
  ] as const) {
    if (value) {
      const problem = oauthEndpointProblem(value, label)
      if (problem) throw new Error(problem)
    }
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
    revocationEndpoint,
    scope: pickScope(o.scopes_supported)
  }
}

async function fetchAsMetadata(issuer: string, fetchImpl: FetchLike): Promise<AsMetadata> {
  const base = issuer.replace(/\/+$/, '')
  try {
    return parseAsMetadata(await fetchJson(`${base}/.well-known/oauth-authorization-server`, fetchImpl))
  } catch (first) {
    try {
      return parseAsMetadata(await fetchJson(`${base}/.well-known/openid-configuration`, fetchImpl))
    } catch {
      throw first
    }
  }
}

/** 从 401 challenge 的 resource_metadata 参数取受保护资源元数据地址（失败返回 null） */
function parseResourceMetadataFromChallenge(header: string | null): string | null {
  if (!header) return null
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header)
  return m?.[1]?.trim() || null
}

async function probeChallengeResourceMetadata(
  serverUrl: string,
  fetchImpl: FetchLike
): Promise<string | null> {
  try {
    const res = await fetchImpl(serverUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
    })
    if (res.status !== 401 && res.status !== 403) return null
    const url = parseResourceMetadataFromChallenge(res.headers.get('www-authenticate'))
    if (!url) return null
    return oauthEndpointProblem(url, '受保护资源元数据地址') ? null : url
  } catch {
    return null
  }
}

/**
 * 自动发现授权服务器元数据。
 * 返回的端点已通过 https/回环/私网闸门；调用方仍需在打开浏览器前复核。
 */
export async function discoverOauthConfig(
  serverUrl: string,
  fetchImpl: FetchLike = safeFetchLike
): Promise<DiscoveredOauthConfig> {
  let origin: string
  try {
    origin = new URL(serverUrl).origin
  } catch {
    throw new Error('远程 MCP 地址不合法，无法发现 OAuth 配置。')
  }

  const resourceUrls: string[] = [
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-resource-metadata`
  ]
  const challengeUrl = await probeChallengeResourceMetadata(serverUrl, fetchImpl)
  if (challengeUrl && !resourceUrls.includes(challengeUrl)) resourceUrls.unshift(challengeUrl)

  let resource: Record<string, unknown> | null = null
  for (const url of resourceUrls) {
    try {
      const raw = await fetchJson(url, fetchImpl)
      if (raw && typeof raw === 'object') {
        resource = raw as Record<string, unknown>
        break
      }
    } catch {
      /* 换下一个 well-known 地址 */
    }
  }

  const authServers = resource ? stringArray(resource.authorization_servers) : []
  const issuer = authServers[0] ?? origin
  let as: AsMetadata | null = null
  try {
    as = await fetchAsMetadata(issuer, fetchImpl)
  } catch (e) {
    // 有些服务器把 AS 元数据直接放在 MCP origin 下
    if (issuer !== origin) {
      try {
        as = await fetchAsMetadata(origin, fetchImpl)
      } catch {
        as = null
      }
    }
    if (!as) {
      const reason = errMsg(e)
      throw new Error(
        `无法发现 OAuth 授权服务器：${reason}。你可以在高级设置里手动填写授权端点与令牌端点。`
      )
    }
  }

  const resourceScope = resource ? pickScope(resource.scopes_supported) : null
  return {
    issuer: as.issuer ?? issuer,
    authorizationEndpoint: as.authorizationEndpoint,
    tokenEndpoint: as.tokenEndpoint,
    registrationEndpoint: as.registrationEndpoint,
    revocationEndpoint: as.revocationEndpoint,
    scope: resourceScope ?? as.scope,
    source: resource ? 'well-known' : 'challenge'
  }
}
