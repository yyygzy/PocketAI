// 便携加密模块 — 用于导出文件加密（不依赖应用内主密码）
//
// 与 backup-service 的区别：
// - backup-service 用 masterKeyManager.getDbKey()，依赖用户已设主密码
// - 本模块从用户输入密码直接派生密钥，salt 内嵌导出文件，可跨机器恢复
//
// 格式（SEC-16-16：档位随头演进，旧文件不失效）：
//   新：MOXENC2(7) + kdfId(1) + salt(16) + iv(12) + tag(16) + ciphertext
//       kdfId=1 → KDF_CURRENT(N=2^17)，kdfId=0 → KDF_LEGACY(N=2^15)
//   旧：MOXENC1(7) + salt(16) + iv(12) + tag(16) + ciphertext
//       无 kdfId，固定 KDF_LEGACY —— 历史导出文件仍可解开。
// Cipher: AES-256-GCM
// 备份信封 PKBK2 已有逐档尝试机制，不在本模块职责内（无需改动）。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveKeySync, KDF_CURRENT, KDF_LEGACY, type KdfParams } from './index'

/** 当前写侧魔数；历史魔数保留只读兼容 */
export const MAGIC = 'MOXENC2'
export const LEGACY_MAGIC = 'MOXENC1'
export const KDF_ID_LEGACY = 0
export const KDF_ID_CURRENT = 1

const MAGIC_LEN = 7 // 两个魔数等长，便于统一解析
const KDF_ID_LEN = 1
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16

function kdfParamsOf(id: number | undefined): KdfParams | null {
  if (id === KDF_ID_LEGACY) return KDF_LEGACY
  if (id === KDF_ID_CURRENT) return KDF_CURRENT
  return null
}

function isEncryptedBlob(buf: Buffer): boolean {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC_LEN) return false
  const magic = buf.subarray(0, MAGIC_LEN).toString('ascii')
  if (magic === MAGIC) {
    return buf.length >= MAGIC_LEN + KDF_ID_LEN + SALT_LEN + IV_LEN + TAG_LEN &&
      kdfParamsOf(buf[MAGIC_LEN]) !== null
  }
  return magic === LEGACY_MAGIC && buf.length >= MAGIC_LEN + SALT_LEN + IV_LEN + TAG_LEN
}

/** 密码加密任意 UTF-8 文本 → Buffer（MOXENC2 + kdfId + salt + iv + tag + ct） */
export function encryptWithPassword(password: string, plaintext: string): Buffer {
  if (!password) throw new Error('密码不能为空')
  if (!plaintext) throw new Error('内容不能为空')

  const { key, salt } = deriveKeySync(password, undefined, KDF_CURRENT)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([
    Buffer.from(MAGIC, 'ascii'),
    Buffer.from([KDF_ID_CURRENT]),
    salt,
    iv,
    tag,
    ct
  ])
}

/** 密码解密 Buffer → UTF-8 文本（按头标识选档；MOXENC1 仍走 N=2^15） */
export function decryptWithPassword(password: string, blob: Buffer): string {
  if (!password) throw new Error('密码不能为空')
  if (!isEncryptedBlob(blob)) throw new Error('文件格式无效（不是加密导出文件）')

  let offset = MAGIC_LEN
  const magic = blob.subarray(0, MAGIC_LEN).toString('ascii')
  const params = magic === MAGIC
    ? kdfParamsOf(blob[offset++])
    : KDF_LEGACY
  if (!params) throw new Error('文件格式无效（不支持的 KDF 档位）')

  const salt = blob.subarray(offset, offset + SALT_LEN); offset += SALT_LEN
  const iv = blob.subarray(offset, offset + IV_LEN); offset += IV_LEN
  const tag = blob.subarray(offset, offset + TAG_LEN); offset += TAG_LEN
  const ct = blob.subarray(offset)

  const { key } = deriveKeySync(password, salt, params)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    throw new Error('密码错误或文件已损坏')
  }
}

export { isEncryptedBlob }
