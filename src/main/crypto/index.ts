// 加密核心模块（M1.1 / L3 字段级加密）
//
// 三层加密职责：
// L1 卷级 → VeraCrypt 便携版 / BitLocker，应用不负责
// L2 库级 → sqlcipher（PRAGMA key），database.ts 预留接口
// L3 字段级 → 本模块，AES-256-GCM 加密敏感字段
//
// 主密码派生：Argon2id → 32 字节 AES 密钥（每个加密上下文独立 salt）
// 字段加密格式：
//   v1: base64(salt:16 + iv:12 + ciphertext + tag:16)
// 每个字段独立 salt + iv，防止彩虹表和密文模式匹配

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { argon2id } from 'hash-wasm'

const AES_KEY_LEN = 32 // AES-256
const GCM_IV_LEN = 12 // AES-GCM 推荐
const GCM_TAG_LEN = 16
const SALT_LEN = 16

// Argon2id 参数（OWASP 2023 推荐，Electron 主进程可接受）
const ARGON2_ITERATIONS = 3
const ARGON2_MEMORY_KB = 65536 // 64MB
const ARGON2_PARALLELISM = 1

export interface KeyMaterial {
  /** 32 字节 AES-256 密钥 */
  key: Buffer
  /** 16 字节 salt（用于重新派生） */
  salt: Buffer
}

/**
 * 用 Argon2id 从主密码派生 AES-256 密钥
 * @param password 用户主密码（或空字符串表示无密码模式）
 * @param salt 如果提供则复用（验证场景），不提供则随机生成
 */
export async function deriveKey(
  password: string,
  salt?: Buffer
): Promise<KeyMaterial> {
  const useSalt = salt ?? randomBytes(SALT_LEN)
  const pw = password || ''

  const hash = await argon2id({
    password: pw,
    salt: useSalt,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    memorySize: ARGON2_MEMORY_KB,
    hashLength: AES_KEY_LEN,
    outputType: 'binary'
  })

  return {
    key: Buffer.from(hash as Uint8Array),
    salt: useSalt
  }
}

/**
 * 同步版本（开发时用，生产建议用 deriveKey）
 * 用 scrypt 代替 argon2id（Node 内置，性能更好）
 */
export function deriveKeySync(password: string, salt?: Buffer): KeyMaterial {
  const useSalt = salt ?? randomBytes(SALT_LEN)
  const key = scryptSync(password || '', useSalt, AES_KEY_LEN, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  })
  return { key, salt: useSalt }
}

/**
 * AES-256-GCM 加密
 * @returns base64(salt + iv + ciphertext + tag)
 */
export function encryptAesGCM(plaintext: string, keyMaterial: KeyMaterial): string {
  const iv = randomBytes(GCM_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', keyMaterial.key, iv)
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([keyMaterial.salt, iv, ct, tag])
  return payload.toString('base64')
}

/**
 * AES-256-GCM 解密
 * @param b64 base64(salt + iv + ciphertext + tag)
 */
export function decryptAesGCM(b64: string, password: string): string | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    const salt = buf.subarray(0, SALT_LEN)
    const iv = buf.subarray(SALT_LEN, SALT_LEN + GCM_IV_LEN)
    const tagStart = buf.length - GCM_TAG_LEN
    const tag = buf.subarray(tagStart)
    const ct = buf.subarray(SALT_LEN + GCM_IV_LEN, tagStart)

    // 重新派生密钥
    const keyMat = deriveKeySync(password, salt)
    const decipher = createDecipheriv('aes-256-gcm', keyMat.key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null // 解密失败：密码错误 / 数据篡改
  }
}

/**
 * 便捷接口：用固定密钥（无主密码模式下的弱加密）
 * 仅用于非敏感场景（如本地配置混淆）
 */
export function encryptWithFixedKey(plaintext: string, fixedKeyHex: string): string {
  const key = Buffer.from(fixedKeyHex, 'hex')
  if (key.length !== AES_KEY_LEN) throw new Error('fixedKey 必须是 32 字节 hex')
  const iv = randomBytes(GCM_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()
  const payload = Buffer.concat([iv, ct, tag])
  return payload.toString('base64')
}

export function decryptWithFixedKey(b64: string, fixedKeyHex: string): string | null {
  try {
    const key = Buffer.from(fixedKeyHex, 'hex')
    const buf = Buffer.from(b64, 'base64')
    const iv = buf.subarray(0, GCM_IV_LEN)
    const tagStart = buf.length - GCM_TAG_LEN
    const tag = buf.subarray(tagStart)
    const ct = buf.subarray(GCM_IV_LEN, tagStart)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null
  }
}

/** 生成固定密钥（启动时随机生成，存 config.json，应用重启后不变） */
export function generateFixedKeyHex(): string {
  return randomBytes(AES_KEY_LEN).toString('hex')
}

/** 快速生成随机 hex 字符串 */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}
