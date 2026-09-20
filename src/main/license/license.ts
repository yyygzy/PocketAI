// License 离线验签模块（M4.3 买断制授权）
//
// license.lic 文件格式：
// {
//   "version": 1,
//   "license_id": "LIC-xxxxxxxxxxxx",
//   "owner": "用户名或组织",
//   "issued_at": 1735689600000,
//   "expires_at": 1767225600000,
//   "plan": "pro",              // free / pro / enterprise
//   "features": ["mcp", "agent", "backup", "encryption", "multi-runtime"],
//   "signature": "base64(RSA-SHA256 签名)"
// }
//
// 验签流程：
// 1. 解析 license JSON，提取除 signature 外的所有字段
// 2. 按 key 字典序拼接规范化字符串
// 3. RSA-SHA256 验签（公钥内置）
// 4. 检查 expires_at、plan、features

import { createVerify, publicDecrypt, constants } from 'node:crypto'
import { PUBLIC_KEY_DER_B64 } from './public-key'

export type LicensePlan = 'free' | 'pro' | 'enterprise'

export interface LicensePayload {
  version: number
  license_id: string
  owner: string
  issued_at: number
  expires_at: number
  plan: LicensePlan
  features: string[]
}

export interface LicenseFile extends LicensePayload {
  signature: string
}

export interface LicenseStatus {
  /** 是否有有效 License */
  valid: boolean
  /** License 信息（valid=true 时完整，valid=false 时可能不完整） */
  payload?: LicensePayload
  /** 失败原因（valid=false 时有值） */
  error?: string
  /** 签名是否通过 */
  signatureOk: boolean
  /** 是否过期 */
  expired: boolean
}

// 需要签名的字段（按 key 字典序）
const SIGN_FIELDS: (keyof LicensePayload)[] = [
  'expires_at',
  'features',
  'issued_at',
  'license_id',
  'owner',
  'plan',
  'version'
]

/** 把 License 载荷规范化为可签名字符串 */
function canonicalize(payload: LicensePayload): string {
  const parts: string[] = []
  for (const key of SIGN_FIELDS) {
    const v = payload[key]
    if (Array.isArray(v)) {
      parts.push(`${key}=${JSON.stringify(v.slice().sort())}`)
    } else {
      parts.push(`${key}=${String(v)}`)
    }
  }
  return parts.join('&')
}

/** 用 RSA 公钥验签 */
function verifySignature(signedData: string, signatureB64: string): boolean {
  try {
    const pubKey = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY_DER_B64}\n-----END PUBLIC KEY-----`
    const verify = createVerify('RSA-SHA256')
    verify.update(signedData)
    verify.end()
    const sigBuf = Buffer.from(signatureB64, 'base64')
    return verify.verify(pubKey, sigBuf)
  } catch {
    return false
  }
}

export class LicenseService {
  private current: LicensePayload | null = null
  private lastError: string | null = null

  /** 从 license.lic 文件加载并验签 */
  loadFromFile(filePath: string): LicenseStatus {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const raw = fs.readFileSync(filePath, 'utf8')
      return this.loadFromString(raw)
    } catch (e) {
      this.lastError = `读取文件失败: ${(e as Error).message}`
      return this.buildStatus(false)
    }
  }

  /** 从字符串加载并验签 */
  loadFromString(content: string): LicenseStatus {
    let file: LicenseFile
    try {
      file = JSON.parse(content) as LicenseFile
    } catch (e) {
      this.lastError = `JSON 解析失败: ${(e as Error).message}`
      return this.buildStatus(false)
    }

    // 1. 必填字段检查
    const missing = SIGN_FIELDS.filter((k) => (file as unknown as Record<string, unknown>)[k] === undefined)
    if (missing.length > 0) {
      this.lastError = `License 缺少字段: ${missing.join(', ')}`
      return this.buildStatus(false)
    }

    const payload: LicensePayload = {
      version: file.version,
      license_id: file.license_id,
      owner: file.owner,
      issued_at: file.issued_at,
      expires_at: file.expires_at,
      plan: file.plan,
      features: file.features
    }

    // 2. 签名验证
    const signedData = canonicalize(payload)
    const signatureOk = verifySignature(signedData, file.signature)
    if (!signatureOk) {
      this.lastError = 'License 签名校验失败（文件可能被篡改或公钥不匹配）'
      return this.buildStatus(false)
    }

    // 3. 过期检查
    const now = Date.now()
    const expired = now > payload.expires_at
    if (expired) {
      this.lastError = `License 已于 ${new Date(payload.expires_at).toLocaleString('zh-CN')} 过期`
      this.current = payload
      return this.buildStatus(false, payload, expired)
    }

    // 全部通过
    this.current = payload
    this.lastError = null
    return this.buildStatus(true, payload, false)
  }

  /** 返回当前 License 状态（不触发验签） */
  getStatus(): LicenseStatus {
    return this.buildStatus(!!this.current, this.current ?? undefined, false)
  }

  /** 清除当前 License */
  clear(): void {
    this.current = null
    this.lastError = null
  }

  /** 检查某个功能是否解锁 */
  hasFeature(feature: string): boolean {
    if (!this.current) return false
    return this.current.features.includes(feature) || this.current.plan === 'enterprise'
  }

  /** 功能门控：无 License 时返回 free 级别 */
  private buildStatus(
    valid: boolean,
    payload?: LicensePayload,
    expired = false
  ): LicenseStatus {
    return {
      valid,
      payload,
      error: valid ? undefined : this.lastError ?? '未找到有效 License',
      signatureOk: valid || this.lastError?.includes('签名校验失败') !== true && payload !== undefined,
      expired
      // 注意：此处不能返回 hasFeature 等函数——IPC 结构化克隆无法序列化函数，
      // 会报 “An object could not be cloned”。功能门控走 license:has-feature 通道。
    }
  }

  /** 生成 license.lic（仅发行侧用，私钥不嵌入应用） */
  static generateLicense(
    privateKeyPem: string,
    payload: LicensePayload
  ): string {
    const signedData = canonicalize(payload)
    const sign = require('node:crypto').createSign('RSA-SHA256')
    sign.update(signedData)
    sign.end()
    const signature = sign.sign(privateKeyPem).toString('base64')
    return JSON.stringify({ ...payload, signature }, null, 2)
  }
}

export const licenseService = new LicenseService()

// ---------- 免费版（Lite）数量门控 ----------
// 免费版（无 License 或 plan=free）限制自建资源数量；pro/enterprise 不受限。
// 门控在 IPC 层调用（ASSISTANT_SAVE / ASSISTANT_DUPLICATE / KB_SAVE）。
export const LITE_LIMITS = {
  assistants: 3, // 用户自建助手（内置助手不计）
  knowledgeBases: 1
} as const

function isPaidPlan(): boolean {
  const cur = licenseService.getStatus()
  return !!cur.valid && (cur.payload?.plan === 'pro' || cur.payload?.plan === 'enterprise')
}

export function assertCanCreateAssistant(nonBuiltinCount: number): void {
  if (isPaidPlan()) return
  if (nonBuiltinCount >= LITE_LIMITS.assistants) {
    throw new Error(
      `免费版最多创建 ${LITE_LIMITS.assistants} 个助手，激活专业版后解除限制（设置 → 授权激活）`
    )
  }
}

export function assertCanCreateKb(count: number): void {
  if (isPaidPlan()) return
  if (count >= LITE_LIMITS.knowledgeBases) {
    throw new Error(
      `免费版最多创建 ${LITE_LIMITS.knowledgeBases} 个知识库，激活专业版后解除限制（设置 → 授权激活）`
    )
  }
}
