// Ed25519 公钥的解析与归一化（主进程专用）。
//
// 支持的输入形态（用户从发布者那里拿到哪一种都能导入）：
//  · PEM（-----BEGIN PUBLIC KEY----- …）
//  · base64 / base64url 的裸 32 字节 Ed25519 公钥
//  · base64 / base64url 的 SPKI DER（44 字节）
// 只接受 Ed25519；其他类型（RSA/EC）一律拒绝，避免用户拿错文件还以为"导入成功"。
import { createHash, createPublicKey, type KeyObject } from 'node:crypto'

/** Ed25519 SPKI DER 的固定前缀：裸 32 字节公钥套上它即可交给 createPublicKey */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface NormalizedEd25519Key {
  /** 归一化后的 PEM（SPKI）——信任库只落这个形态，比较时不看用户原始输入 */
  pem: string
  /** SPKI DER 的 SHA-256（小写十六进制），给界面人工核对 */
  fingerprint: string
}

function decodeBase64Loose(text: string): Buffer {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * 解析公钥文本并归一化。失败一律抛中文原因（直接进界面/IPC 失败面）。
 * 注意：不把原始公钥内容拼进错误信息，避免日志里出现半截密钥。
 */
export function normalizeEd25519PublicKey(text: string): NormalizedEd25519Key {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('公钥不能为空')

  let key: KeyObject
  try {
    if (raw.includes('-----BEGIN PUBLIC KEY-----')) {
      key = createPublicKey({ key: raw, format: 'pem' })
    } else {
      const bytes = decodeBase64Loose(raw.replace(/\s+/g, ''))
      if (bytes.length === 32) {
        key = createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
          format: 'der',
          type: 'spki'
        })
      } else {
        key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
      }
    }
  } catch {
    throw new Error('公钥无法解析：请提供 Ed25519 公钥（PEM，或 base64 的 32 字节裸公钥 / SPKI DER）')
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`公钥类型不对（${key.asymmetricKeyType ?? '未知'}）：只接受 Ed25519 公钥`)
  }

  const der = key.export({ format: 'der', type: 'spki' })
  const derBytes = Buffer.isBuffer(der) ? der : Buffer.from(der)
  const fingerprint = createHash('sha256').update(derBytes).digest('hex')
  const pem = key.export({ format: 'pem', type: 'spki' }).toString()
  return { pem, fingerprint }
}

/** 信任库里已归一化的 PEM → 指纹（读列表时重算，不额外存字段） */
export function fingerprintOfPem(pem: string): string {
  const key = createPublicKey({ key: pem, format: 'pem' })
  const der = key.export({ format: 'der', type: 'spki' })
  const derBytes = Buffer.isBuffer(der) ? der : Buffer.from(der)
  return createHash('sha256').update(derBytes).digest('hex')
}
