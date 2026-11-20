// MCP 连接器目录的签名信任（信封 v2）与本地信任库的数据口径。
//
// 设计边界（与实现同一条尺子）：
//  · 远程目录必须装在 `pocketai-mcp-catalog/2` 签名信封里，Ed25519 签名；
//  · 默认信任库为空：用户显式导入发布者公钥后才可能验签通过；
//  · 内置官方公钥只留结构占位（`BUILTIN_MCP_CATALOG_TRUST_KEYS` 为空数组），
//    真发版时由发行侧注入，这里绝不塞任何真实或编造的密钥；
//  · 未签名的 v1 远程目录一律拒绝，不做兼容放行；
//  · 本文件只放**渲染层也能用**的纯数据与纯函数，验签/哈希在主进程完成。
import { z } from 'zod'

/** 签名信封格式：只在 v2 以上；v1（未签名）被显式拒绝 */
export const MCP_CATALOG_ENVELOPE_FORMAT = 'pocketai-mcp-catalog/2'

/** 签名数据里 keyId 的形状（同时用于信任库条目的 keyId） */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 信任库条目（落 app_config 的 JSON 数组）。
 * `publicKey` 统一归一化为 PEM（SPKI），`source=builtin` 只有发行侧注入的那把才用。
 */
export interface McpCatalogTrustKeyRecord {
  keyId: string
  /** Ed25519 公钥；落库前已归一化为 PEM（SPKI） */
  publicKey: string
  label: string
  addedAt: number
  source: 'user' | 'builtin'
}

/** 给界面的脱敏视图：多一个指纹便于用户和发布者核对 */
export interface McpCatalogTrustKeyView {
  keyId: string
  label: string
  /** SHA-256(SPKI DER) 的十六进制；用于人工核对公钥 */
  fingerprint: string
  addedAt: number
  source: 'user' | 'builtin'
}

/** 用户导入公钥的 IPC 入参 */
export const mcpCatalogTrustKeyInputSchema = z.object({
  keyId: z
    .string()
    .min(1)
    .max(64)
    .regex(KEY_ID_PATTERN, 'keyId 只能包含字母/数字/下划线/短横线'),
  /** PEM，或 base64/base64url 的裸 32 字节 Ed25519 公钥 / SPKI DER */
  publicKey: z.string().min(1).max(4096),
  label: z.string().max(120).optional()
})

export type McpCatalogTrustKeyInput = z.infer<typeof mcpCatalogTrustKeyInputSchema>

/**
 * 官方发行公钥槽位。**当前刻意留空**：
 *  - 默认信任库为空，远程目录必须由用户自己导入的公钥验过才会加载；
 *  - 真发版时由发行流程在此注入官方公钥（keyId + PEM），不在本次实现里放任何密钥。
 */
export const BUILTIN_MCP_CATALOG_TRUST_KEYS: readonly McpCatalogTrustKeyRecord[] = []

/** 信封里被撤销的对象：keyId 命中 ⇒ 整份目录拒绝；条目 id/hash 命中 ⇒ 只丢弃该条 */
export interface McpCatalogRevokedList {
  keyIds: string[]
  entryIds: string[]
  /** SHA-256(规范 JSON(entry)) 的小写十六进制 */
  entryHashes: string[]
}

export const mcpCatalogRevokedListSchema = z.object({
  keyIds: z.array(z.string().min(1).max(64).regex(KEY_ID_PATTERN)).max(100).optional(),
  entryIds: z.array(z.string().min(1).max(64)).max(1000).optional(),
  entryHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000).optional()
})

/**
 * 信封结构（签名验证**之前**只做形状校验，字段一律按不可信数据处理）。
 * `payload` 故意保持 unknown：验签通过后才交给目录解析器。
 */
export const mcpCatalogEnvelopeSchema = z.object({
  format: z.literal(MCP_CATALOG_ENVELOPE_FORMAT),
  keyId: z.string().min(1).max(64).regex(KEY_ID_PATTERN),
  serial: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  payload: z.unknown(),
  /** Ed25519 签名：64 字节 → base64url 86 字符（无填充） */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
})

export interface McpCatalogEnvelope {
  format: typeof MCP_CATALOG_ENVELOPE_FORMAT
  keyId: string
  serial: number
  issuedAt: number
  payload: unknown
  signature: string
}

/** 签名覆盖的字节：信封去掉 signature 后的规范 JSON（递归键排序） */
export function catalogSigningInput(envelope: Omit<McpCatalogEnvelope, 'signature'>): string {
  return canonicalJson({
    format: envelope.format,
    keyId: envelope.keyId,
    serial: envelope.serial,
    issuedAt: envelope.issuedAt,
    payload: envelope.payload
  })
}

/**
 * 递归键排序的规范 JSON：对象键按字典序、数组保持原序。
 * 发布侧与客户端必须用同一套规则，否则签名对不上。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonDeep(value)) ?? 'null'
}

function sortJsonDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonDeep)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = sortJsonDeep(src[key])
    return out
  }
  return value
}

/** 视图里的指纹形态（主进程算好塞进来，渲染层只显示） */
export type McpCatalogTrustKeyViews = McpCatalogTrustKeyView[]
