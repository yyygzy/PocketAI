// 字段级加密工具（M1.1 L3 层）
//
// 透明加解密：在 repo 层自动处理
// - 读：检测密文（v1: 前缀）→ 解密；SEC-16-07：明文只在「迁移完成标记」未落时
//   直通（兼容旧库的迁移期通道），标记落盘后非密文形状一律 fail-closed 返回空串
// - 写：总是加密后存储
//
// 密文格式：v1:base64(iv:12 + ciphertext + tag:16)
// 明文格式：JSON string（现有数据）

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { masterKeyManager } from './master-key'
import { createLogger } from '../logger'

const log = createLogger('crypto')

const CIPHER_PREFIX = 'v1:'
const IV_LEN = 12
const TAG_LEN = 16

/**
 * 判断是否为加密密文。
 *
 * §384：以前只看前缀 ⇒ 一条恰好以 `v1:` 开头的**明文**会被当成"已加密"，
 * 于是写侧的幂等防护把它原样落盘（明文进库），读侧又把它当解不开的密文（`hasUndecryptableCipher` 恒真）
 * ＝屏上永远说"解不开"、重填同一句还是原样落盘＝出不去的循环。
 * 现在按信封的真实结构判：`v1:` ＋ 规范 base64（长度是 4 的倍数、解码后再编码一字不差）＋ 至少装得下 IV+TAG。
 *
 * 残余歧义如实写明：随机 ASCII 口令里仍有约 1.7% 撞得进这个形状（探针 `data/tmp/probe-384-iscipher.mjs`），
 * 所以形状判据只是把误判面从"以 v1: 开头"缩到"v1:＋规范 base64＋≥40 位"，
 * **根治在写侧声明意图**（见 `saveWebDAVConfig` 的 `passwordAlreadyCipher`），不是把形状猜得更准。
 */
export function isCipherText(s: string): boolean {
  if (!s.startsWith(CIPHER_PREFIX)) return false
  const body = s.slice(CIPHER_PREFIX.length)
  if (body.length < ((IV_LEN + TAG_LEN) / 3) * 4 || body.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false
  const buf = Buffer.from(body, 'base64')
  // round-trip 必须相等：不接受被 Node 悄悄丢掉的非法字符，也不接受多余的填充
  if (buf.length < IV_LEN + TAG_LEN || buf.toString('base64') !== body) return false
  return true
}

// ─── SEC-16-07：明文迁移完成标记 ──────────────────────────────────
//
// 标记本体落在 app_config 的 `crypto.plaintext_migration_done`（随数据走：整库恢复
// 旧备份时标记跟着旧库一起回退，读侧自动回到明文直通，等下一次启动的迁移把明文
// 升级后再落标记）。
//
// 为什么是「注入」而不是 field-encrypt 直接 import appConfigRepo：field-encrypt 被
// provider.repo / mcp-server.repo / backup-service 等大量模块引用，一旦引上
// app-config.repo，就把 db → portable → electron 整条重链拖进它的每一个引用方
// （几十份单测环境会当场炸在 app.isPackaged 上）。所以标记的读写由 secret-store
// 在模块加载时经 wirePlaintextMigrationMarker 注入（secret-store 本来就引着
// appConfigRepo）；未接线的环境（纯单测）默认「未完成」＝明文直通，与旧行为一致。
// 生产路径 index.ts 顶层 import secret-store，接线必然先于一切解密调用发生。
export const PLAINTEXT_MIGRATION_DONE_KEY = 'crypto.plaintext_migration_done'

let readMigrationMarker: () => boolean = () => false
let writeMigrationMarker: { mark(): void; clear(): void } | null = null

/** 由 secret-store 模块加载时注入标记的读/写实现（幂等，重复注入以最后一次为准） */
export function wirePlaintextMigrationMarker(
  read: () => boolean,
  write: { mark(): void; clear(): void }
): void {
  readMigrationMarker = read
  writeMigrationMarker = write
}

/** 迁移完成标记是否已落盘（DB 不可用等异常一律按「未完成」＝明文直通处理） */
export function isPlaintextMigrationDone(): boolean {
  try {
    return readMigrationMarker()
  } catch {
    return false
  }
}

/** 落「明文迁移已完成」标记（由 secret-store 的迁移收尾在确认无明文残留后调用） */
export function markPlaintextMigrationDone(): void {
  writeMigrationMarker?.mark()
}

/** 撤回标记（迁移收尾发现明文残留时回退到直通通道，让下个启动的迁移能读出明文） */
export function clearPlaintextMigrationDone(): void {
  writeMigrationMarker?.clear()
}

/** 单字符串加密：任意 UTF-8 文本 → v1:base64（空串返回空串） */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return ''
  const fieldKey = masterKeyManager.getFieldKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', fieldKey, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return CIPHER_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64')
}

/**
 * 单字符串解密（SEC-16-07：明文直通只在迁移完成标记未落时生效）。
 * 密文损坏/密钥不匹配/锁定期间 → 返回空串（fail closed，调用方按无凭据处理）。
 */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!isCipherText(stored)) {
    // SEC-16-07：改前这里对一切非密文原样返回（fail-open）＝凭据完整性边界靠猜形状，
    // none 模式下密文列被替换成任意明文也会被当真凭据读走。
    // 现在由「明文迁移已完成」标记把通道收窄成迁移期专用：标记未落（旧库首次升级、
    // 迁移尚未跑完/迁移失败重试）保持直通，让三个迁移函数能把历史明文读出来升级；
    // 标记落盘后（正常稳态）非密文形状一律按数据损坏处理，fail-closed。
    if (isPlaintextMigrationDone()) {
      log.warn(`字段值既不是密文也不是已知明文形态，按无凭据处理: len=${stored.length}`)
      return ''
    }
    return stored // 迁移期明文：直接返回（等待本次启动的迁移升级为密文）
  }
  try {
    const fieldKey = masterKeyManager.getFieldKey()
    const buf = Buffer.from(stored.slice(CIPHER_PREFIX.length), 'base64')
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', fieldKey, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    log.warn('字段密文解密失败（密钥不匹配、锁定中或数据损坏）')
    return ''
  }
}

/** 加密 apiKeys 数组 → v1:base64 */
export function encryptApiKeys(apiKeys: string[]): string {
  if (!apiKeys || apiKeys.length === 0) return ''
  return encryptSecret(JSON.stringify(apiKeys))
}

/** 解密 apiKeys → string[]（向后兼容明文 JSON） */
export function decryptApiKeys(stored: string | null | undefined): string[] {
  if (!stored) return []
  const plaintext = decryptSecret(stored)
  if (!plaintext) return []
  try {
    const v = JSON.parse(plaintext)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * 加密字符串映射（MCP env / headers）→ v1:base64。
 * 空映射存空串，避免为「无凭据」的行也产生一次密钥派生写入。
 */
export function encryptSecretMap(map: Record<string, string> | null | undefined): string {
  const entries = Object.entries(map ?? {})
  if (entries.length === 0) return ''
  return encryptSecret(JSON.stringify(Object.fromEntries(entries)))
}

/** 解密字符串映射（向后兼容历史明文 JSON；失败 fail-closed 返回 {}） */
export function decryptSecretMap(stored: string | null | undefined): Record<string, string> {
  if (!stored) return {}
  const plaintext = decryptSecret(stored)
  if (!plaintext) return {}
  try {
    const v = JSON.parse(plaintext) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val ?? '')
    return out
  } catch {
    return {}
  }
}

/**
 * 轮换导出专用：区分「没配过凭据」与「有密文但解不开」这两态。
 *
 * decryptSecret 的 catch 把二者都折成 ''（→ decryptApiKeys 折成 []、decryptSecretMap 折成 {}），
 * 而「解不开」的行（旧字段密钥不匹配／密文损坏，§323 那种半状态）在语义上绝不是「没凭据」：
 * 轮换时它进不了明文快照，若又被当成「没配过」悄悄跳过，旧钥密文就原地留在被换掉的字段密钥下 ⇒ 永久解不开。
 * ⇒ 三个轮换导出器都用这颗把它单独请出来（跳过重写、但如实上报），别和「真没配」混一栏。
 *
 * 判据成立的前提：空值从不以密文形态落盘（encryptSecret('')=''、encryptApiKeys([])=''、encryptSecretMap({})=''），
 * 所以「是密文却解出空」只可能是解不开，不可能是「配了个空」。
 */
export function hasUndecryptableCipher(stored: string | null | undefined): boolean {
  if (!stored || !isCipherText(stored)) return false
  return decryptSecret(stored) === ''
}
