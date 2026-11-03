// web_search 工具的联网搜索配置（app_config KV，模式与 shell-config 一致）
//
// - agent.websearch_enabled        ：'1' 开启；缺省/其它=关闭（默认安全）
// - agent.websearch_provider       ：'tavily'（默认）| 'bocha' | 'searxng'
// - agent.websearch_tavily_key     ：Tavily API Key（字段级密文）
// - agent.websearch_bocha_key      ：博查 API Key（字段级密文）
// - agent.websearch_api_key        ：历史单槽 Key（boot 时幂等迁移后删除）
// - agent.websearch_searxng_url    ：SearXNG 实例基地址（空=未配置，不内置公共实例）
// - agent.websearch_searxng_allow_private：'1'=用户显式确认允许该地址走私网/环回
//
// 安全约定：getWebSearchConfig 面向渲染端返回时永远不回传 Key 明文（apiKey='' + hasKey 标记）；
// 主进程内部读 Key 用 getWebSearchSecret()。私网放行只对 searxngBaseUrl 的精确 origin 生效，
// 且默认关闭；URL 为公网/空时强制回落 false，避免旧勾选在改地址后被继承。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { getSecret, setSecret, hasSecret, SECRET_KV_KEYS } from '../crypto/secret-store'
import type { WebSearchConfig, WebSearchProvider } from '../../shared/types'
import { websearchConfigSchema } from '../../shared/schemas/agent'
import { isPrivateHostname } from '../net/safe-fetch'
import { createLogger } from '../logger'

const log = createLogger('websearch')

const KEY_ENABLED = 'agent.websearch_enabled'
const KEY_PROVIDER = 'agent.websearch_provider'
const KEY_SEARXNG_URL = 'agent.websearch_searxng_url'
const KEY_SEARXNG_ALLOW_PRIVATE = 'agent.websearch_searxng_allow_private'

const MAX_API_KEY_CHARS = 256
const MAX_SEARXNG_URL_CHARS = 512

function readProvider(): WebSearchProvider {
  const raw = appConfigRepo.get(KEY_PROVIDER)
  return raw === 'bocha' || raw === 'searxng' ? raw : 'tavily'
}

/** provider 对应的密钥槽（searxng 无 Key，返回 null） */
function providerKeySlot(provider: WebSearchProvider): string | null {
  if (provider === 'bocha') return SECRET_KV_KEYS.WEBSEARCH_BOCHA_KEY
  if (provider === 'tavily') return SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY
  return null
}

function readSearxngUrl(): string {
  return appConfigRepo.get(KEY_SEARXNG_URL) ?? ''
}

function readSearxngAllowPrivate(): boolean {
  return appConfigRepo.get(KEY_SEARXNG_ALLOW_PRIVATE) === '1'
}

/**
 * 校验并规整 SearXNG 基地址（纯函数，非法即抛错）。
 * - 仅 http/https，≤512 字符，不含账号密码/query/fragment
 * - 去掉末尾斜杠，保留子路径（如 https://searx.example.com/searxng）
 */
export function normalizeSearxngBaseUrl(raw: string): { url: string; privateHost: boolean } | null {
  const s = raw.trim()
  if (!s) return null
  if (s.length > MAX_SEARXNG_URL_CHARS) {
    throw new Error('SearXNG 地址过长（上限 512 字符）')
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('SearXNG 地址格式无效，需形如 http://127.0.0.1:8080 或 https://searx.example.com')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('SearXNG 地址仅支持 http:// 或 https://')
  }
  if (!u.hostname) throw new Error('SearXNG 地址缺少主机名')
  if (u.username || u.password) throw new Error('SearXNG 地址不能包含账号密码')
  if (u.search || u.hash) throw new Error('SearXNG 地址不能包含查询参数或锚点')
  const path = u.pathname.replace(/\/+$/, '')
  return { url: u.origin + path, privateHost: isPrivateHostname(u.hostname) }
}

/** 渲染端视图：不含 Key 明文 */
export function getWebSearchConfig(): WebSearchConfig {
  const enabled = appConfigRepo.get(KEY_ENABLED) === '1'
  const provider = readProvider()
  const slot = providerKeySlot(provider)
  return {
    enabled,
    provider,
    apiKey: '',
    hasKey: slot ? hasSecret(slot) : false,
    searxngBaseUrl: readSearxngUrl(),
    searxngAllowPrivate: readSearxngAllowPrivate()
  }
}

/** 保存配置（字段白名单 + 值域校验）。apiKey：undefined=不动，''=清除，非空=覆盖 */
export function setWebSearchConfig(
  input: Partial<{
    enabled: boolean
    provider: WebSearchProvider
    apiKey: string
    searxngBaseUrl: string
    searxngAllowPrivate: boolean
  }>
): WebSearchConfig {
  const patch = websearchConfigSchema.parse(input)

  // 先完成全部校验（尤其 URL），再写库：非法地址不应顺带改掉 enabled/provider
  const nextProvider = patch.provider ?? readProvider()
  let nextUrl = readSearxngUrl()
  let nextAllow = readSearxngAllowPrivate()
  if (typeof patch.searxngBaseUrl === 'string') {
    const normalized = normalizeSearxngBaseUrl(patch.searxngBaseUrl)
    if (normalized) {
      nextUrl = normalized.url
    } else {
      nextUrl = ''
      nextAllow = false
    }
  }
  if (typeof patch.searxngAllowPrivate === 'boolean') nextAllow = patch.searxngAllowPrivate
  // 只有当前地址确属本机/内网时才可能为 true；公网/空地址强制回落，避免改地址后继承旧确认
  if (nextUrl) {
    const parsed = new URL(nextUrl)
    if (!isPrivateHostname(parsed.hostname)) nextAllow = false
  } else {
    nextAllow = false
  }

  if (typeof patch.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, patch.enabled ? '1' : '0')
  }
  if (patch.provider) appConfigRepo.set(KEY_PROVIDER, patch.provider)

  const slot = providerKeySlot(nextProvider)
  if (typeof patch.apiKey === 'string' && slot) {
    const trimmed = patch.apiKey.trim()
    if (trimmed.length === 0) {
      setSecret(slot, '')
    } else if (trimmed.length > MAX_API_KEY_CHARS) {
      // 不静默丢弃：明确拒绝，由渲染端提示用户（上限对应历史存储约束）
      throw new Error('API Key 过长（上限 256 字符），请检查后重试')
    } else {
      setSecret(slot, trimmed)
    }
  }

  if (nextUrl) appConfigRepo.set(KEY_SEARXNG_URL, nextUrl)
  else appConfigRepo.delete(KEY_SEARXNG_URL)
  if (nextAllow) appConfigRepo.set(KEY_SEARXNG_ALLOW_PRIVATE, '1')
  else appConfigRepo.delete(KEY_SEARXNG_ALLOW_PRIVATE)

  return getWebSearchConfig()
}

/** 主进程内部读取配置明文（仅供 registry 发请求用） */
export function getWebSearchSecret(): {
  enabled: boolean
  provider: WebSearchProvider
  apiKey: string
  searxngBaseUrl: string
  searxngAllowPrivate: boolean
} {
  const provider = readProvider()
  const slot = providerKeySlot(provider)
  return {
    enabled: appConfigRepo.get(KEY_ENABLED) === '1',
    provider,
    apiKey: slot ? getSecret(slot) : '',
    searxngBaseUrl: readSearxngUrl(),
    searxngAllowPrivate: readSearxngAllowPrivate()
  }
}

/**
 * 历史单槽 Key → 按 provider 键的一次性迁移（幂等）。
 * 必须在字段密钥可用后调用（index.ts 的 migrateKvSecrets 之后）。
 * 当前 provider=searxng 时迁到 tavily 槽，保留用户后续切换 Tavily 可用。
 */
export function migrateLegacyWebSearchKey(): void {
  try {
    const legacy = getSecret(SECRET_KV_KEYS.WEBSEARCH_API_KEY)
    if (!legacy) return
    const target =
      readProvider() === 'bocha'
        ? SECRET_KV_KEYS.WEBSEARCH_BOCHA_KEY
        : SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY
    if (!getSecret(target)) setSecret(target, legacy)
    setSecret(SECRET_KV_KEYS.WEBSEARCH_API_KEY, '')
    log.info(`历史联网搜索 Key 已迁移到 ${target}`)
  } catch (e) {
    // 迁移失败不阻断启动；旧键保留，下次启动重试（幂等）
    log.warn('历史联网搜索 Key 迁移失败:', e instanceof Error ? e.message : e)
  }
}
