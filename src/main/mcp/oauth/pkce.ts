// OAuth PKCE / state 生成（RFC 7636 + RFC 6749）。
//
// 只生成随机值与 S256 challenge；不碰 token。verifier 只存在于主进程内存，
// 授权完成后随 pending 记录一起丢弃，不落库、不进日志。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const VERIFIER_BYTES = 32

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(VERIFIER_BYTES))
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest())
  return { verifier, challenge, method: 'S256' }
}

export function createOauthState(): string {
  return base64url(randomBytes(24))
}

/** 定长比较 state，避免可疑的时序侧信道（state 本身短且一次性） */
export function safeStateEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}
