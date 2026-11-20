// 远程连接器目录的签名信任（主进程）：本地信任库、Ed25519 验签、serial 防回滚。
//
// 失败一律 fail-closed：
//  · 未签名 v1 / 未知 keyId / 签名不符 / serial 回滚 / 签名密钥被撤销 ⇒ 整份远程目录不加载；
//  · 单条被撤销 ⇒ 只丢弃该条（原因随 rejected 一起回），其余照常过安全闸门；
//  · 信任库默认空，用户显式导入公钥后才可能验签通过；内置官方公钥槽位当前为空。
import { createHash, verify as cryptoVerify } from 'node:crypto'
import { z } from 'zod'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { createLogger } from '../logger'
import {
  BUILTIN_MCP_CATALOG_TRUST_KEYS,
  canonicalJson,
  catalogSigningInput,
  mcpCatalogEnvelopeSchema,
  mcpCatalogTrustKeyInputSchema,
  type McpCatalogEnvelope,
  type McpCatalogTrustKeyInput,
  type McpCatalogTrustKeyRecord,
  type McpCatalogTrustKeyView
} from '../../shared/mcp-catalog-trust'
import { explainUnsignedRemoteCatalog } from '../../shared/mcp-catalog'
import { fingerprintOfPem, normalizeEd25519PublicKey } from './catalog-trust-keys'

const log = createLogger('mcp')

const KEY_TRUST_KEYS = 'mcp_catalog_trust_keys'
/** 每个 keyId 的已见最高 serial；回滚只和「同一把钥匙」比 */
const KEY_SERIAL_PREFIX = 'mcp_catalog_serial_'

const storedKeySchema = z.object({
  keyId: z.string().min(1).max(64),
  publicKey: z.string().min(1),
  label: z.string(),
  addedAt: z.number().int().nonnegative(),
  source: z.enum(['user', 'builtin'])
})

const storedKeysSchema = z.array(storedKeySchema).max(200)

function readUserKeys(): McpCatalogTrustKeyRecord[] {
  const raw = appConfigRepo.get(KEY_TRUST_KEYS)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error('本地信任库损坏（不是合法 JSON），远程目录已拒绝加载；请重新导入发布者公钥')
  }
  const result = storedKeysSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error('本地信任库损坏（条目结构不合法），远程目录已拒绝加载；请重新导入发布者公钥')
  }
  return result.data.map((k) => ({ ...k, source: 'user' as const }))
}

function writeUserKeys(keys: McpCatalogTrustKeyRecord[]): void {
  appConfigRepo.set(KEY_TRUST_KEYS, JSON.stringify(keys))
}

function toView(key: McpCatalogTrustKeyRecord): McpCatalogTrustKeyView {
  let fingerprint = ''
  try {
    fingerprint = fingerprintOfPem(key.publicKey)
  } catch {
    // 落库前已归一化；这里失败只可能是 DB 被手工改过。列表照常列出，验签时会给出明确拒绝。
    fingerprint = ''
  }
  return {
    keyId: key.keyId,
    label: key.label,
    fingerprint,
    addedAt: key.addedAt,
    source: key.source
  }
}

/** 信任库全量视图：内置官方槽位（当前为空） + 用户导入的发布者公钥 */
export function listTrustKeys(): McpCatalogTrustKeyView[] {
  const user = readUserKeys()
  return [...BUILTIN_MCP_CATALOG_TRUST_KEYS, ...user].map(toView)
}

/**
 * 导入发布者公钥。keyId 由发布者给出；同一 keyId 换公钥会被拒绝（避免悄悄换掉信任根）。
 * 同一把公钥换个 keyId 也拒绝：信任库里的公钥必须一一对应，否则撤销时会含糊。
 */
export function importTrustKey(input: McpCatalogTrustKeyInput): McpCatalogTrustKeyView[] {
  const parsed = mcpCatalogTrustKeyInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || '公钥导入参数不合法')
  }
  const keyId = parsed.data.keyId.trim()
  const label = (parsed.data.label ?? '').trim() || keyId
  const normalized = normalizeEd25519PublicKey(parsed.data.publicKey)

  const keys = readUserKeys()
  const sameId = keys.find((k) => k.keyId === keyId)
  if (sameId) {
    if (sameId.publicKey !== normalized.pem) {
      throw new Error(`keyId「${keyId}」已被另一把公钥占用；请向发布者确认后换一个 keyId，或先移除旧公钥`)
    }
    // 同一把钥匙重复导入：只更新备注，addedAt 保留最早那次
    if (sameId.label !== label) {
      sameId.label = label
      writeUserKeys(keys)
    }
    return listTrustKeys()
  }

  const duplicated = keys.find((k) => {
    try {
      return fingerprintOfPem(k.publicKey) === normalized.fingerprint
    } catch {
      return false
    }
  })
  if (duplicated) {
    throw new Error(`这把公钥已以 keyId「${duplicated.keyId}」导入，请勿重复导入`)
  }

  keys.push({
    keyId,
    publicKey: normalized.pem,
    label,
    addedAt: Date.now(),
    source: 'user'
  })
  writeUserKeys(keys)
  log.info(`已导入发布者公钥：${keyId}（指纹 ${normalized.fingerprint.slice(0, 16)}…）`)
  return listTrustKeys()
}

/** 移除信任的公钥；serial 高水位保留（重新导入同一把钥匙也不能借此回滚目录版本） */
export function removeTrustKey(rawKeyId: string): McpCatalogTrustKeyView[] {
  const keyId = String(rawKeyId ?? '').trim()
  if (!keyId) throw new Error('缺少要移除的 keyId')
  const keys = readUserKeys()
  const next = keys.filter((k) => k.keyId !== keyId)
  if (next.length === keys.length) throw new Error(`信任库里没有 keyId「${keyId}」`)
  writeUserKeys(next)
  log.info(`已移除发布者公钥：${keyId}`)
  return listTrustKeys()
}

function findTrustKey(keyId: string): McpCatalogTrustKeyRecord | null {
  const all = [...BUILTIN_MCP_CATALOG_TRUST_KEYS, ...readUserKeys()]
  return all.find((k) => k.keyId === keyId) ?? null
}

function readSerialHighWater(keyId: string): number {
  const raw = appConfigRepo.get(KEY_SERIAL_PREFIX + keyId)
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 验签成功且内容被接受后才记高水位（失败/回滚不推进） */
export function commitCatalogSerial(keyId: string, serial: number): void {
  if (!Number.isFinite(serial) || serial <= 0) return
  const current = readSerialHighWater(keyId)
  if (serial <= current) return
  appConfigRepo.set(KEY_SERIAL_PREFIX + keyId, String(Math.floor(serial)))
}

function revokedKeyIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const revoked = (payload as { revoked?: unknown }).revoked
  if (!revoked || typeof revoked !== 'object') return []
  const ids = (revoked as { keyIds?: unknown }).keyIds
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
}

export interface VerifiedCatalogEnvelope {
  keyId: string
  serial: number
  issuedAt: number
  payload: unknown
}

/**
 * 验签 + 防回滚 + 撤销签名密钥。
 * 返回的是**已验签**的 payload；条目级安全闸门与撤销条目由 catalog.ts 继续处理。
 */
export function verifyCatalogEnvelope(raw: unknown): VerifiedCatalogEnvelope {
  const unsignedReason = explainUnsignedRemoteCatalog(raw)
  if (unsignedReason) throw new Error(unsignedReason)

  const parsed = mcpCatalogEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('远程目录签名信封格式不正确（需要 pocketai-mcp-catalog/2 的 keyId/serial/issuedAt/payload/signature）')
  }
  const envelope = parsed.data as McpCatalogEnvelope

  const keyRecord = findTrustKey(envelope.keyId)
  if (!keyRecord) {
    throw new Error(
      `远程目录签名者不在本地信任库（keyId=${envelope.keyId}），已拒绝加载。请先导入该发布者的 Ed25519 公钥后再刷新。`
    )
  }

  let pem: string
  try {
    pem = normalizeEd25519PublicKey(keyRecord.publicKey).pem
  } catch (e) {
    throw new Error(`本地信任库里的公钥无法解析（keyId=${envelope.keyId}），已拒绝加载：${(e as Error).message}`)
  }

  const signingInput = catalogSigningInput({
    format: envelope.format,
    keyId: envelope.keyId,
    serial: envelope.serial,
    issuedAt: envelope.issuedAt,
    payload: envelope.payload
  })
  let ok = false
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(signingInput, 'utf8'),
      pem,
      Buffer.from(envelope.signature, 'base64url')
    )
  } catch {
    ok = false
  }
  if (!ok) {
    throw new Error('远程目录签名校验失败：内容与签名不一致，已拒绝加载。')
  }

  if (revokedKeyIds(envelope.payload).includes(envelope.keyId)) {
    throw new Error(`远程目录的签名密钥已被发布者撤销（keyId=${envelope.keyId}），已拒绝加载。`)
  }

  const highWater = readSerialHighWater(envelope.keyId)
  if (envelope.serial < highWater) {
    throw new Error(
      `远程目录版本回滚（serial ${envelope.serial} 低于本机已见的 ${highWater}），已拒绝加载。`
    )
  }

  return {
    keyId: envelope.keyId,
    serial: envelope.serial,
    issuedAt: envelope.issuedAt,
    payload: envelope.payload
  }
}

/** 撤销列表里的条目说明（entryHashes = SHA-256(规范 JSON(entry))，小写十六进制） */
export function revokedEntryReason(payload: unknown, entryId: string, rawEntry: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const revoked = (payload as { revoked?: unknown }).revoked
  if (!revoked || typeof revoked !== 'object') return null
  const ids = (revoked as { entryIds?: unknown }).entryIds
  const hashes = (revoked as { entryHashes?: unknown }).entryHashes
  if (Array.isArray(ids) && ids.includes(entryId)) return '已被发布者撤销'
  if (Array.isArray(hashes) && hashes.length > 0) {
    const hash = createHash('sha256').update(canonicalJson(rawEntry)).digest('hex')
    if (hashes.includes(hash)) return '已被发布者撤销'
  }
  return null
}
