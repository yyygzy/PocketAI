// 连接器目录的主进程服务：内置清单 + 可选**已验签**的远程索引缓存。
//
// 安全前提（与共享层同一把尺）：
//  · 默认不访问任何远程地址，只用本地内置清单；
//  · 远程索引必须由用户显式填入 https 地址，且不指向本机/内网；
//  · 远程索引必须装在 pocketai-mcp-catalog/2 签名信封里，Ed25519 验签通过才加载；
//    未签名 v1、未知 keyId、签名不符、serial 回滚、签名密钥被撤销 ⇒ 整份拒绝（fail-closed）；
//  · 验签后的条目仍逐条过安全闸门与被撤销条目过滤，不安全的条目整条丢弃并留痕；
//  · 这里只负责“目录数据”，安装/连接仍走 mcpServerRepo.save + mcpManager.start。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import {
  listBuiltinMcpCatalog,
  mergeCatalogEntries,
  parseRemoteCatalogPayload,
  remoteCatalogIndexUrlProblem,
  type McpCatalogEntry,
  type McpCatalogView
} from '../../shared/mcp-catalog'
import { verifyCatalogEnvelope, commitCatalogSerial, revokedEntryReason } from './catalog-trust'

const log = createLogger('mcp')

const KEY_INDEX_URL = 'mcp_catalog_index_url'
const KEY_REMOTE_JSON = 'mcp_catalog_remote_json'
const KEY_REMOTE_UPDATED_AT = 'mcp_catalog_remote_updated_at'

const MAX_INDEX_BYTES = 512 * 1024
const INDEX_TIMEOUT_MS = 12_000

interface StoredRemoteIndex {
  url: string
  updatedAt: number
  raw: string
}

function readStoredRemote(): { stored: StoredRemoteIndex | null; error?: string } {
  try {
    const url = appConfigRepo.get(KEY_INDEX_URL) ?? ''
    const raw = appConfigRepo.get(KEY_REMOTE_JSON) ?? ''
    const updatedAt = Number(appConfigRepo.get(KEY_REMOTE_UPDATED_AT) ?? 0) || 0
    if (!raw) return { stored: null }
    return { stored: { url, updatedAt, raw } }
  } catch (e) {
    return { stored: null, error: `远程目录缓存读取失败：${errMsg(e)}` }
  }
}

/** 验签 + 条目安全闸门 + 撤销条目过滤；失败抛中文原因（调用方决定是整份拒绝还是回退内置） */
function parseVerifiedRemote(rawText: string): {
  entries: McpCatalogEntry[]
  rejected: string[]
  verified: { keyId: string; serial: number; issuedAt: number }
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText) as unknown
  } catch {
    throw new Error('远程目录不是合法的 JSON。')
  }
  const verified = verifyCatalogEnvelope(parsed)
  const result = parseRemoteCatalogPayload(verified.payload, {
    entryRevoked: (entry, rawEntry) => revokedEntryReason(verified.payload, entry.id, rawEntry)
  })
  return {
    entries: result.entries,
    rejected: result.rejected,
    verified: { keyId: verified.keyId, serial: verified.serial, issuedAt: verified.issuedAt }
  }
}

/** 当前目录视图：内置清单 + 已缓存且验签通过的远程条目 */
export function listMcpCatalog(): McpCatalogView {
  const builtin = listBuiltinMcpCatalog()
  const { stored, error } = readStoredRemote()
  let remoteEntries: McpCatalogEntry[] = []
  let remoteError = error
  let remoteVerified: McpCatalogView['remoteVerified']
  if (stored) {
    try {
      const result = parseVerifiedRemote(stored.raw)
      remoteEntries = result.entries
      remoteVerified = result.verified
      if (result.rejected.length > 0) {
        log.warn(`远程目录有 ${result.rejected.length} 条未通过校验：${result.rejected.slice(0, 3).join('；')}`)
      }
    } catch (e) {
      remoteError = `远程目录未加载（已回退到内置清单）：${errMsg(e)}`
      log.warn(remoteError)
    }
  }
  return {
    entries: mergeCatalogEntries(remoteEntries),
    builtinCount: builtin.length,
    remoteCount: remoteEntries.length,
    indexUrl: stored?.url ?? safeGetIndexUrl(),
    updatedAt: stored?.updatedAt ?? 0,
    ...(remoteVerified ? { remoteVerified } : {}),
    ...(remoteError ? { remoteError } : {})
  }
}

function safeGetIndexUrl(): string {
  try {
    return appConfigRepo.get(KEY_INDEX_URL) ?? ''
  } catch {
    return ''
  }
}

/**
 * 拉取远程索引并缓存。url 为空时复用上次保存的地址；
 * 两者都没有时明确拒绝（默认只用内置清单，绝不偷偷接第三方注册表）。
 * 拉回来的内容必须通过签名信任（承载在 pocketai-mcp-catalog/2 信封里）。
 */
export async function refreshMcpCatalog(inputUrl?: string | null): Promise<McpCatalogView> {
  const rawUrl = String(inputUrl ?? '').trim()
  const url = rawUrl || safeGetIndexUrl()
  if (!url) {
    throw new Error('尚未配置远程目录地址：默认只使用本地内置清单。如需更新，请填写可信的 https 地址。')
  }
  const urlProblem = remoteCatalogIndexUrlProblem(url)
  if (urlProblem) throw new Error(urlProblem)

  let text: string
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`远程目录请求失败（HTTP ${res.status}）`)
    text = await res.text()
  } catch (e) {
    const msg = errMsg(e)
    if (/abort|timeout|timed out/i.test(msg)) {
      throw new Error('远程目录读取超时，请检查网络后重试。')
    }
    throw new Error(`远程目录读取失败：${msg}`)
  }

  if (text.length > MAX_INDEX_BYTES) {
    throw new Error(`远程目录过大（超过 ${MAX_INDEX_BYTES / 1024}KB），已拒绝。`)
  }

  const result = parseVerifiedRemote(text)
  if (result.entries.length === 0) {
    const reason = result.rejected[0] ?? '没有可用条目'
    throw new Error(`远程目录没有可用连接器：${reason}`)
  }
  if (result.rejected.length > 0) {
    log.warn(`远程目录已更新，但拒绝 ${result.rejected.length} 条：${result.rejected.slice(0, 3).join('；')}`)
  }

  // 内容已被接受才推进高水位：失败/回滚不推进，避免用坏包把本机版本钉高
  commitCatalogSerial(result.verified.keyId, result.verified.serial)

  const updatedAt = Date.now()
  appConfigRepo.set(KEY_INDEX_URL, url)
  appConfigRepo.set(KEY_REMOTE_JSON, text)
  appConfigRepo.set(KEY_REMOTE_UPDATED_AT, String(updatedAt))
  log.info(
    `远程连接器目录已更新：${result.entries.length} 条可用，${result.rejected.length} 条被拒（签名 keyId=${result.verified.keyId} serial=${result.verified.serial}）`
  )
  return listMcpCatalog()
}

/** 清空远程目录缓存，回到纯内置清单（地址也一并清掉，避免下次误用）；信任库与 serial 高水位保留 */
export function resetMcpCatalog(): McpCatalogView {
  try {
    appConfigRepo.delete(KEY_REMOTE_JSON)
    appConfigRepo.delete(KEY_REMOTE_UPDATED_AT)
    appConfigRepo.delete(KEY_INDEX_URL)
  } catch (e) {
    log.warn(`清空远程目录失败：${errMsg(e)}`)
  }
  return listMcpCatalog()
}
