// 恢复密钥（Recovery Code）
//
// 用途：忘记主密码时，凭恢复码重置密码，避免「忘密码 = 数据永久丢失」。
//
// 安全模型：
// - 恢复码 160bit 随机熵（20 字节，Crockford Base32 → 32 字符，4 个一组展示）
// - config.json 存恢复包：rv1:base64(kdfSalt(16) + iv(12) + AES-GCM(masterKey) + tag(16))
// - 包必须在 DB 之外：忘密码时 DB 打不开，不能产生读取死锁（与 salt 同通道）
// - 包的解密密钥 = scrypt(恢复码, 包内 salt)；拿到 config.json 也只能离线暴破恢复码
// - 恢复码只在生成/重新生成时展示一次，应用自身不存明文
//
// 重要联动：改主密码会 rekey，masterKey 改变 → 旧恢复包失效。
// 因此改密流程若检测到已设置恢复码，必须用新 masterKey 重新生成并让用户重新保存。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { deriveKeySync } from './index'

const BLOB_PREFIX = 'rv1:'
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const RAW_LEN = 20 // 恢复码随机字节数（160bit）

// Crockford Base32 字母表（排除易混字符 I/L/O/U；解码时做容错映射）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DECODE_MAP: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i++) DECODE_MAP[ALPHABET[i]!] = i
// 常见看错/打错容错：I/L → 1，O → 0
DECODE_MAP['I'] = DECODE_MAP['1']!
DECODE_MAP['L'] = DECODE_MAP['1']!
DECODE_MAP['O'] = DECODE_MAP['0']!

/** 字节 → Crockford Base32 字符串 */
function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** 规整用户输入：去分隔符/空白、大写、容错映射 */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
}

/** 生成新恢复码（返回带分隔符的展示形式 XXXX-XXXX-...，8 组） */
export function generateRecoveryCode(): string {
  const raw = randomBytes(RAW_LEN)
  const encoded = base32Encode(raw) // 32 字符
  return encoded.match(/.{4}/g)!.join('-')
}

/** 用恢复码派生密钥并加密 masterKey，落盘恢复包 */
function wrapMasterKey(code: string, masterKey: Buffer): string {
  const salt = randomBytes(SALT_LEN)
  // 恢复码高熵，仍走全应用唯一 scrypt 派生路径，防短码离线暴破
  const wrapKey = deriveKeySync(code, salt).key
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', wrapKey, iv)
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return BLOB_PREFIX + Buffer.concat([salt, iv, ct, tag]).toString('base64')
}

/** 解开恢复包：恢复码错误/包损坏 → null（调用方按无效处理） */
function unwrapMasterKey(code: string, blob: string): Buffer | null {
  try {
    if (!blob.startsWith(BLOB_PREFIX)) return null
    const buf = Buffer.from(blob.slice(BLOB_PREFIX.length), 'base64')
    if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) return null
    const salt = buf.subarray(0, SALT_LEN)
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
    const tag = buf.subarray(buf.length - TAG_LEN)
    const ct = buf.subarray(SALT_LEN + IV_LEN, buf.length - TAG_LEN)
    const wrapKey = deriveKeySync(code, salt).key
    const decipher = createDecipheriv('aes-256-gcm', wrapKey, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    if (pt.length !== 32) return null
    return pt
  } catch {
    return null
  }
}

export const recoveryKeyManager = {
  /** 是否已设置恢复密钥（设置页用；DB 锁定时读不到 config 之外的状态故不依赖 DB） */
  hasRecovery(): boolean {
    return appConfigRepo.getRecoveryBlob() !== null
  },

  /**
   * 为当前 masterKey 生成/重新生成恢复密钥。
   * @returns 恢复码明文（仅此一次返回，调用方负责安全展示后即弃）
   */
  enableRecovery(masterKey: Buffer): string {
    if (!masterKey || masterKey.length !== 32) {
      throw new Error('恢复密钥只能在已设置主密码（db 模式）下生成')
    }
    const code = generateRecoveryCode()
    const blob = wrapMasterKey(normalizeRecoveryCode(code), masterKey)
    appConfigRepo.setRecoveryBlob(blob)
    return code
  },

  /** 删除恢复密钥（禁用加密或用户主动撤销时调用） */
  disableRecovery(): void {
    appConfigRepo.clearRecoveryBlob()
  },

  /**
   * 用恢复码还原 masterKey（忘记密码流程）。
   * @throws 未设置恢复密钥 / 恢复码错误或损坏
   */
  recoverMasterKey(inputCode: string): Buffer {
    const blob = appConfigRepo.getRecoveryBlob()
    if (!blob) throw new Error('未设置恢复密钥')
    const code = normalizeRecoveryCode(inputCode)
    if (code.length !== 32) throw new Error('恢复密钥格式不正确（应为 32 位字符）')
    const key = unwrapMasterKey(code, blob)
    if (!key) throw new Error('恢复密钥无效，请重新输入')
    return key
  }
}
