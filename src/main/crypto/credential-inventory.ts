// 已落盘字段凭据的清点（禁用加密前的二次确认与审计用）
//
// 只数「有没有值」，不解密：判据与 hasSecret 同源（落盘非空即算），
// 因此解不开的密文也计入——它同样是被本次降级影响的存量凭据。
// 覆盖五类：KV 密钥（渠道/联网搜索）、Provider apiKeys、MCP env/headers、WebDAV 口令。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { dbService } from '../db/database'
import { SECRET_KV_KEYS } from './secret-store'

export interface CredentialInventory {
  /** KV 单值密钥（渠道 token、联网搜索 Key） */
  kv: number
  /** Provider apiKeys */
  providers: number
  /** MCP env/headers（按 Server 计，一个 Server 有任一非空即算一项） */
  mcp: number
  /** WebDAV 备份口令（0/1） */
  webdav: number
  total: number
}

/**
 * 与 backup-service.ts 的 CFG_KEY 同键。
 * 这里不 import backup-service：那会把整条备份链拉进加密 IPC 的静态依赖，
 * 而本模块只需要键名与一个字段的「有无」。
 */
const WEBDAV_CONFIG_KEY = 'webdav_config'

function countRows(sql: string): number {
  const row = dbService.getHandle().prepare(sql).get() as { n: number } | undefined
  return row?.n ?? 0
}

function hasWebDAVPassword(): boolean {
  const raw = appConfigRepo.get(WEBDAV_CONFIG_KEY)
  if (!raw) return false
  try {
    const cfg = JSON.parse(raw) as { passwordCipher?: unknown }
    return typeof cfg.passwordCipher === 'string' && cfg.passwordCipher.trim() !== ''
  } catch {
    return false
  }
}

/** 清点当前落盘的字段凭据（必须在 DB 已打开时调用） */
export function countStoredCredentials(): CredentialInventory {
  const kv = Object.values(SECRET_KV_KEYS).filter((k) => !!appConfigRepo.get(k)).length
  const providers = countRows(
    "SELECT COUNT(*) AS n FROM providers WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted <> ''"
  )
  const mcp = countRows(
    "SELECT COUNT(*) AS n FROM mcp_servers WHERE (env IS NOT NULL AND env <> '') OR (headers IS NOT NULL AND headers <> '')"
  )
  const webdav = hasWebDAVPassword() ? 1 : 0
  return { kv, providers, mcp, webdav, total: kv + providers + mcp + webdav }
}
