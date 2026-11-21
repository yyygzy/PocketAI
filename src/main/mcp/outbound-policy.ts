// MCP 出网的站点级约束
//
// 职责：MCP **HTTP** 传输的目标 URL 在发请求前校验 host。默认拒绝清单外地址
// （allowOtherHosts=false）；用户显式打开「允许其它主机」或把 host 加入清单后才可连接。
// DNS 解析与 IP pinning 由 net/safe-fetch 在每次建连时完成，本文件只负责站点级字符串策略。
// 出口计数（dry-run 判据）在零依赖的 `outbound-metrics.ts`——本文件要读 app_config，
// 不能把协议层单元测试拖进「配置 → 数据库 → electron」这条链。
//
// 与另外三套机制的关系（不重复造清单）：
//  - `net/outbound-registry.ts` 是**只读声明清单**：枚举应用会连哪些地址，覆盖测试盯住
//    调用点，用于展示与审计。它是"声明"，不是执行闸，从不拦截请求。
//  - 逐工具 confirm（MCP 工具默认 confirm，`'*'` 不覆盖）是**动作授权**：谁可以调哪个工具，
//    发生在工具执行前，完全不决定连接目标。
//  - `trustReadOnly` 只把只读工具从 confirm 降级为 allow，是**授权强度**，同样不看域名。
//  - 本文件是**连接级域名闸**：只判断"能不能连这个 host"。域名清单直接复用用户在
//    `mcp_servers.url` 里填的地址，不另造一份数据源；开启收紧时把要允许的 host 抄进来即可。
//
// 已知做不到（如实写在这里，不用"看起来做到"的实现糊过去）：
//  stdio MCP server 是独立子进程，网络由 OS 直连（可能还会自己下载依赖），PocketAI
//  没有流量 hook / 防火墙权限，**无法按域名拦截或观测**。stdio 侧的替代判据是
//  `tools/call` 计数（没有调用就没有"让子进程去干什么"）+ 回放期禁止建立 MCP 连接。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { createLogger } from '../logger'

const log = createLogger('mcp-outbound')

/** app_config 键：站点策略 JSON（{ allowedHosts, allowOtherHosts }） */
export const MCP_HTTP_SITE_POLICY_KEY = 'mcp_http_site_policy'

/** 被站点策略拒绝时的稳定前缀：调用方与测试按它认，不按错误文案认 */
export const MCP_HOST_BLOCKED = 'MCP_HOST_BLOCKED'

/** 允许清单条数上限：策略是手写清单，不是防火墙规则集，够用即可 */
export const MCP_MAX_ALLOWED_HOSTS = 100
/** 单个 host 长度上限（DNS 名上限 253） */
const MCP_MAX_HOST_CHARS = 253

export interface McpSitePolicy {
  /** 允许连接的 host（小写、不含协议/端口/路径）；`allowOtherHosts=false` 时生效 */
  allowedHosts: string[]
  /** true=用户显式允许清单外主机；false=只允许 allowedHosts 内的 host（默认，失败关闭） */
  allowOtherHosts: boolean
}

const DEFAULT_POLICY: McpSitePolicy = { allowedHosts: [], allowOtherHosts: false }

/**
 * 把用户输入规整成 host：接受裸域名、host:port 或完整 URL，统一取出 hostname。
 * 取不出来（空串、含空格、非法字符）返回 null，由调用方决定是丢弃还是报错。
 */
export function sanitizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '' || value.length > MCP_MAX_HOST_CHARS) return null
  let host: string
  try {
    // 已带协议就按 URL 解析；否则补 http:// 再解析（这样 host:port、[::1]:3000 都能吃下）
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).hostname
  } catch {
    return null
  }
  host = host.trim().toLowerCase().replace(/\.$/, '')
  return host === '' ? null : host
}

/**
 * 读取侧的归一化：非法项直接丢弃（不是把整份配置判坏）——
 * 一份手写配置里混进一行空行，不应该让整台机器的 MCP 全部连不上。
 */
export function normalizeMcpSitePolicy(raw: unknown): McpSitePolicy {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const seen = new Set<string>()
  const list = Array.isArray(o.allowedHosts) ? o.allowedHosts : []
  for (const item of list) {
    const host = sanitizeHost(item)
    if (host) seen.add(host)
    if (seen.size >= MCP_MAX_ALLOWED_HOSTS) break
  }
  return {
    allowedHosts: [...seen],
    // 缺省 false：未显式打开「允许其它主机」时按清单收口（失败关闭）
    allowOtherHosts: o.allowOtherHosts === true
  }
}

let cachedRaw: string | null | undefined
let cachedPolicy: McpSitePolicy = DEFAULT_POLICY
let readFailureLogged = false

/** 当前站点策略（app_config 读缓存；DB 未开时按默认拒绝，且只记一次 warn） */
export function getMcpSitePolicy(): McpSitePolicy {
  let raw: string | null
  try {
    raw = appConfigRepo.get(MCP_HTTP_SITE_POLICY_KEY)
  } catch (e) {
    if (!readFailureLogged) {
      readFailureLogged = true
      log.warn(`站点策略读取失败（按默认拒绝处理）: ${e instanceof Error ? e.message : String(e)}`)
    }
    return DEFAULT_POLICY
  }
  if (raw === cachedRaw) return cachedPolicy
  let parsed: unknown = null
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      log.warn('站点策略 JSON 解析失败（按默认拒绝处理）')
    }
  }
  cachedRaw = raw
  cachedPolicy = normalizeMcpSitePolicy(parsed)
  return cachedPolicy
}

/**
 * 保存侧校验：**非法输入一律拒绝**（与读取侧相反）。
 * 用户正在编辑的清单如果连 host 都解析不出来，静默丢掉就等于"我明明加了却没生效"。
 */
export function saveMcpSitePolicy(input: unknown): McpSitePolicy {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const rawList = Array.isArray(o.allowedHosts) ? o.allowedHosts : []
  const hosts: string[] = []
  for (const item of rawList) {
    const text = typeof item === 'string' ? item.trim() : ''
    if (text === '') continue
    const host = sanitizeHost(text)
    if (!host) throw new Error(`域名格式无效：${text}`)
    if (!hosts.includes(host)) hosts.push(host)
  }
  if (hosts.length > MCP_MAX_ALLOWED_HOSTS) {
    throw new Error(`允许的域名不能超过 ${MCP_MAX_ALLOWED_HOSTS} 个`)
  }
  const policy: McpSitePolicy = {
    allowedHosts: hosts,
    // 必须显式打开：缺省/误传 false 都按拒绝处理（失败关闭）
    allowOtherHosts: o.allowOtherHosts === true
  }
  appConfigRepo.set(MCP_HTTP_SITE_POLICY_KEY, JSON.stringify(policy))
  cachedRaw = undefined
  return policy
}

/** 纯判定：策略是否放行该 host（导出供测试与调用方复用同一把尺） */
export function isMcpHostAllowed(host: string, policy: McpSitePolicy): boolean {
  if (policy.allowOtherHosts) return true
  return policy.allowedHosts.includes(host.toLowerCase())
}

/**
 * 发请求前的站点策略断言（纯字符串匹配，不做 DNS）。
 * DNS 解析/IP pinning/逐跳重定向校验由 `net/safe-fetch` 在建连时完成，
 * http-transport 以 maxRedirects:0 禁止任何跳转，策略不会被重定向绕过。
 */
export function assertMcpHostAllowed(rawUrl: string, serverName?: string): void {
  const policy = getMcpSitePolicy()
  const host = sanitizeHost(rawUrl)
  if (!isMcpHostAllowed(host ?? '', policy)) {
    const target = host ?? rawUrl
    throw new Error(
      `${MCP_HOST_BLOCKED}:站点策略不允许连接 ${target}${serverName ? `（${serverName}）` : ''}`
    )
  }
}

/** 回环地址：用户显式打开「允许其它主机」时仍允许本地 MCP server（本地开发场景） */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  return h === 'localhost' || h === '::1' || h.startsWith('127.')
}

/**
 * 仅当目标 host 明确在白名单（或用户显式允许其它主机且目标是回环）时，
 * 才把该 origin 交给 safeFetch 作为私网放行 origin。
 * 其余情况返回 undefined——域名解析到内网/保留地址时 safeFetch 会拒绝建连。
 */
export function mcpAllowedPrivateOrigin(rawUrl: string): string | undefined {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  const host = sanitizeHost(u.hostname)
  if (!host) return undefined
  const policy = getMcpSitePolicy()
  const explicitlyAllowed =
    policy.allowedHosts.includes(host) || (policy.allowOtherHosts && isLoopbackHost(host))
  return explicitlyAllowed ? u.origin : undefined
}

