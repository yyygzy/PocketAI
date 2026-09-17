// 字段级加密工具（M1.1 L3 层）
//
// 透明加解密：在 repo 层自动处理
// - 读：检测密文（v1: 前缀）→ 解密；否则视为明文直接返回（向后兼容）
// - 写：总是加密后存储
//
// 密文格式：v1:base64(iv:12 + ciphertext + tag:16)
// 明文格式：JSON string（现有数据）

import { masterKeyManager } from './master-key'

const CIPHER_PREFIX = 'v1:'
const IV_LEN = 12
const TAG_LEN = 16

/** 判断是否为加密密文 */
export function isCipherText(s: string): boolean {
  return s.startsWith(CIPHER_PREFIX)
}

/** 加密 apiKeys 数组 → v1:base64 */
export function encryptApiKeys(apiKeys: string[]): string {
  if (!apiKeys || apiKeys.length === 0) return ''
  const plaintext = Buffer.from(JSON.stringify(apiKeys), 'utf8')
  const fieldKey = masterKeyManager.getFieldKey()
  const { createCipheriv, randomBytes } = require('node:crypto')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', fieldKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return CIPHER_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64')
}

/** 解密 apiKeys → string[]（向后兼容明文 JSON） */
export function decryptApiKeys(stored: string | null | undefined): string[] {
  if (!stored) return []

  if (isCipherText(stored)) {
    try {
      return decryptCipherText(stored)
    } catch {
      console.warn('[crypto] apiKeys 解密失败（密钥不匹配或数据损坏）')
      return []
    }
  }

  // 明文 JSON → 直接解析
  try {
    const v = JSON.parse(stored)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function decryptCipherText(stored: string): string[] {
  const { createDecipheriv } = require('node:crypto')
  const fieldKey = masterKeyManager.getFieldKey()
  const buf = Buffer.from(stored.slice(CIPHER_PREFIX.length), 'base64')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', fieldKey, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  const v = JSON.parse(pt.toString('utf8'))
  return Array.isArray(v) ? v.map(String) : []
}
