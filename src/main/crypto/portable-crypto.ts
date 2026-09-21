// 便携加密模块 — 用于导出文件加密（不依赖应用内主密码）
//
// 与 backup-service 的区别：
// - backup-service 用 masterKeyManager.getDbKey()，依赖用户已设主密码
// - 本模块从用户输入密码直接派生密钥，salt 内嵌导出文件，可跨机器恢复
//
// 格式：MOXENC1(7) + salt(16) + iv(12) + tag(16) + ciphertext
// KDF: scryptSync(N=32768, r=8, p=1) → 32 字节 AES-256 key
// Cipher: AES-256-GCM

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { deriveKeySync } from './index'

const MAGIC = 'MOXENC1'
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16

function isEncryptedBlob(buf: Buffer): boolean {
  return buf.length >= MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN &&
    buf.slice(0, MAGIC.length).toString('ascii') === MAGIC
}

/** 密码加密任意 UTF-8 文本 → Buffer（含 magic + salt + iv + tag + ct） */
export function encryptWithPassword(password: string, plaintext: string): Buffer {
  if (!password) throw new Error('密码不能为空')
  if (!plaintext) throw new Error('内容不能为空')

  const { key, salt } = deriveKeySync(password)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([
    Buffer.from(MAGIC, 'ascii'),
    salt,
    iv,
    tag,
    ct
  ])
}

/** 密码解密 Buffer → UTF-8 文本 */
export function decryptWithPassword(password: string, blob: Buffer): string {
  if (!password) throw new Error('密码不能为空')
  if (!isEncryptedBlob(blob)) throw new Error('文件格式无效（不是加密导出文件）')

  let offset = MAGIC.length
  const salt = blob.subarray(offset, offset + SALT_LEN); offset += SALT_LEN
  const iv = blob.subarray(offset, offset + IV_LEN); offset += IV_LEN
  const tag = blob.subarray(offset, offset + TAG_LEN); offset += TAG_LEN
  const ct = blob.subarray(offset)

  const { key } = deriveKeySync(password, salt)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return pt.toString('utf8')
  } catch {
    throw new Error('密码错误或文件已损坏')
  }
}

export { isEncryptedBlob, MAGIC }
