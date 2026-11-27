// 出网清单 v2：全局出网 allowlist 的**纯闸门**。
//
// 这里刻意不 import 数据库/electron：safeFetch 是大量纯函数测试的直接依赖，
// 一旦带上 app-config.repo → database → portable → electron.app，CI 会在 import 阶段炸。
// 策略读取器由 IPC handler 在注册时用 setOutboundPolicyReader 注入；未注入时保持关闭。
export const OUTBOUND_POLICY_KEY = 'net.outbound_site_policy'

export interface OutboundSitePolicy {
  enabled: boolean
  /** 规范化后的 hostname 列表（小写、无协议、无端口、无路径） */
  allowedHosts: string[]
}

export const DEFAULT_OUTBOUND_SITE_POLICY: OutboundSitePolicy = {
  enabled: false,
  allowedHosts: []
}

type PolicyReader = () => OutboundSitePolicy
let policyReader: PolicyReader = () => ({ ...DEFAULT_OUTBOUND_SITE_POLICY, allowedHosts: [] })

/** IPC handler 注册时注入真实仓储读取；纯函数测试不注入就是默认关闭。 */
export function setOutboundPolicyReader(reader: PolicyReader): void {
  policyReader = reader
}

export function resetOutboundPolicyReader(): void {
  policyReader = () => ({ ...DEFAULT_OUTBOUND_SITE_POLICY, allowedHosts: [] })
}

export function normalizeOutboundHost(input: string): string {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase()
  } catch {
    return raw.replace(/^https?:\/\//, '').split(/[/?#:]/)[0] ?? ''
  }
}

export function normalizeOutboundSitePolicy(input: unknown): OutboundSitePolicy {
  const raw = (input ?? {}) as { enabled?: unknown; allowedHosts?: unknown }
  const hosts = Array.isArray(raw.allowedHosts)
    ? raw.allowedHosts
        .map((h) => normalizeOutboundHost(typeof h === 'string' ? h : ''))
        .filter((h) => h.length > 0)
    : []
  return {
    enabled: raw.enabled === true,
    allowedHosts: Array.from(new Set(hosts)).slice(0, 200)
  }
}

export function isOutboundHostAllowed(host: string, policy: OutboundSitePolicy = policyReader()): boolean {
  const normalized = normalizeOutboundHost(host)
  if (!normalized) return false
  if (!policy.enabled) return true
  return policy.allowedHosts.includes(normalized)
}

/** 域名级早拦；SSRF/DNS/IP 校验仍在 safeFetch 后续各跳执行。 */
export function assertOutboundHostAllowed(url: URL | string, policy: OutboundSitePolicy = policyReader()): void {
  const u = typeof url === 'string' ? new URL(url) : url
  if (isOutboundHostAllowed(u.hostname, policy)) return
  const error = new Error(`出网被策略拦截：${u.hostname} 不在 allowlist 中`) as Error & { code: string }
  error.code = 'OUTBOUND_HOST_BLOCKED'
  throw error
}

/** 仅供 IPC 层做状态回填，不参与判定。 */
export function readInjectedOutboundPolicy(): OutboundSitePolicy {
  return policyReader()
}
