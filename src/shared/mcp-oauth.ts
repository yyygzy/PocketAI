// 远程 MCP OAuth 的共享类型与端点校验。
//
// 边界：OAuth 端点默认必须是 https；仅本机回环（127.0.0.1 / localhost / ::1）允许 http，
// 便于本地开发服务。拒绝 URL 内账号密码，拒绝私网地址，避免把授权码/刷新令牌送到内网。
import { z } from 'zod'
import { isLoopbackHost } from './url-policy'

export type McpOauthStatus = 'authorized' | 'needs_reauth' | 'error'

/** 渲染层可见的授权视图：绝不包含 access/refresh token 或 client_secret */
export interface McpOauthView {
  serverId: string
  status: McpOauthStatus
  issuer: string | null
  scope: string | null
  /** access token 过期时间（ms）；0/null=服务端未返回过期时间 */
  expiresAt: number | null
  /** 是否存有 refresh token（只给布尔，不给值） */
  hasRefreshToken: boolean
  /** 已人话化的最近失败原因；成功时为空 */
  lastError: string | null
  updatedAt: number
}

/** 手动端点配置（发现失败时的回退；也可完全不填走自动发现） */
export interface McpOauthManualConfig {
  issuer?: string | null
  authorizationEndpoint?: string | null
  tokenEndpoint?: string | null
  registrationEndpoint?: string | null
  revocationEndpoint?: string | null
  scope?: string | null
  /** 服务端不支持动态注册时，可手动填已预注册的客户端 */
  clientId?: string | null
  clientSecret?: string | null
}

/** 回调固定路径（回环端口随机，路径固定便于服务端精确注册 redirect_uri） */
export const MCP_OAUTH_CALLBACK_PATH = '/mcp/oauth/callback'

/** IPC 入参：手动端点/预注册客户端（全部可选；最终仍由主进程做安全闸门校验） */
export const mcpOauthManualConfigSchema = z.object({
  issuer: z.string().max(2048).nullish(),
  authorizationEndpoint: z.string().max(2048).nullish(),
  tokenEndpoint: z.string().max(2048).nullish(),
  registrationEndpoint: z.string().max(2048).nullish(),
  revocationEndpoint: z.string().max(2048).nullish(),
  scope: z.string().max(1024).nullish(),
  clientId: z.string().max(512).nullish(),
  clientSecret: z.string().max(2048).nullish()
})

export function isLoopbackOauthHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || isLoopbackHost(h)
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h) || /^0\.0\.0\.0$/.test(h)) return true
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

/**
 * OAuth 端点安全闸：https（回环允许 http/https）、无账号密码、非私网。
 * 返回 null 表示通过，否则返回人话原因。
 */
export function oauthEndpointProblem(raw: string | null | undefined, label = 'OAuth 端点'): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return `${label}不能为空`
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return `${label}不是合法地址`
  }
  if (u.username || u.password) return `${label}不能携带账号密码`
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `${label}必须是 https（本机回环可用 http）`
  const loopback = isLoopbackOauthHost(u.hostname)
  if (u.protocol !== 'https:' && !loopback) return `${label}必须是 https（本机回环可用 http）`
  if (isPrivateHost(u.hostname) && !loopback) return `${label}不能指向内网地址`
  return null
}

/** 只允许 http/https 且有 host 的回调/授权地址（打开浏览器前再核一次） */
export function isOpenableOauthUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
