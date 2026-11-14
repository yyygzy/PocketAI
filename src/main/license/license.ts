// License 离线验签模块（M4.3 买断制授权）
//
// license.lic 文件格式：
// {
//   "version": 1,
//   "license_id": "LIC-xxxxxxxxxxxx",
//   "owner": "用户名或组织",
//   "issued_at": 1735689600000,
//   "expires_at": 1767225600000, // 使用截止（到期后不再提供付费能力）
//   "updates_until": 1767225600000, // 更新截止（v2 起参与签名；缺失时回退 expires_at）
//   "plan": "pro",              // free / pro / enterprise
//   "features": ["mcp", "agent", "backup", "encryption", "multi-runtime"],
//   "disk_fingerprint": "",     // 硬盘指纹（SHA-256 前 16 位 hex）；空串 = 不绑定设备
//   "signature": "base64(RSA-SHA256 签名)"
// }
//
// 验签流程：
// 1. 解析 license JSON，提取除 signature 外的所有字段（含 disk_fingerprint）
// 2. 按 key 字典序拼接规范化字符串（与应用内 SIGN_FIELDS、发行侧 issue-license.js 一致）
// 3. RSA-SHA256 验签（公钥内置）
// 4. 检查 expires_at、plan、features
// 5. disk_fingerprint 非空时与 getDiskFingerprint()（APP_ROOT 所在硬盘）比对

import { createVerify } from 'node:crypto'
import { PUBLIC_KEY_DER_B64 } from './public-key'
import { getDiskFingerprint } from '../steward/hardware'
import { effectiveUpdatesUntil, raiseUpdatesWatermark } from './updates-watermark'
import { errMsg } from '../error'

export type LicensePlan = 'free' | 'pro' | 'enterprise'

/**
 * 更新截止：v2 取签名内的 updates_until；历史许可证回退为 expires_at（不追溯收紧）。
 * 发行侧 issue-license.js 的同名逻辑必须与此保持一致。
 */
export function updatesUntilOf(payload: LicensePayload): number {
  return typeof payload.updates_until === 'number' ? payload.updates_until : payload.expires_at
}

export interface LicensePayload {
  version: number
  license_id: string
  owner: string
  issued_at: number
  /** 使用截止：到点后付费能力失效（数量上限回落免费版等） */
  expires_at: number
  /**
   * 更新截止（v2 起写入并参与签名）。
   * 缺失 = 历史许可证：语义回退为 expires_at（不追溯收紧老用户的更新权益）。
   */
  updates_until?: number
  plan: LicensePlan
  features: string[]
  /**
   * 硬盘指纹绑定（可选，SHA-256 前 16 位 hex）。
   * - 有值：必须与 APP_ROOT 所在物理硬盘序列号的哈希匹配才 valid
   *   （同一硬盘插任意电脑都能通过，符合便携定位；复制到别的硬盘则拒绝）
   * - 无值 / 空串：不绑定设备（向后兼容旧 license）
   */
  disk_fingerprint?: string
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
  /** 使用截止是否已过 */
  expired: boolean
  /** 更新期是否已结束（有效更新期 = max(许可证, 本机高水位)；两者都没有时恒 false） */
  updatesExpired: boolean
  /** 有效更新截止（许可证自带值与本机高水位取较晚者；历史许可证回退为 expires_at） */
  updatesUntil?: number
}

// 需要签名的字段（按 key 字典序）
// v1 = 历史许可证字段集（无 updates_until），v2 = 多一个更新截止。
// 以「文件里是否带 updates_until」决定用哪套字段集：
// - 给 v1 件补字段 ⇒ 签名串不一致，验签失败
// - 从 v2 件删字段 ⇒ 签名串不一致，验签失败
// 因此不能靠「新字段必填」兼容历史件，也不能让删字段回退成永久更新。
const SIGN_FIELDS_V1: (keyof LicensePayload)[] = [
  'disk_fingerprint',
  'expires_at',
  'features',
  'issued_at',
  'license_id',
  'owner',
  'plan',
  'version'
]

const SIGN_FIELDS_V2: (keyof LicensePayload)[] = [
  'disk_fingerprint',
  'expires_at',
  'features',
  'issued_at',
  'license_id',
  'owner',
  'plan',
  'updates_until',
  'version'
]

function signFieldsOf(payload: LicensePayload): (keyof LicensePayload)[] {
  return payload.updates_until === undefined ? SIGN_FIELDS_V1 : SIGN_FIELDS_V2
}

/** 把 License 载荷规范化为可签名字符串 */
function canonicalize(payload: LicensePayload): string {
  const parts: string[] = []
  for (const key of signFieldsOf(payload)) {
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
  /**
   * @param watermarkPath 本机更新期高水位文件路径。
   *   缺省 = app.getPath('userData')；测试可传临时目录，避免写真实应用数据。
   */
  constructor(private readonly watermarkPath?: string | null) {}

  private current: LicensePayload | null = null
  /**
   * 最近一次「签名通过但已过使用截止」的许可证。
   * 保留它只为让重启后仍能显示「已过期（日期）」而不是「未激活」；
   * 不得用于 hasFeature / 数量门控等任何授权判定。
   */
  private expiredPayload: LicensePayload | null = null
  private lastError: string | null = null

  /** 从 license.lic 文件加载并验签 */
  loadFromFile(filePath: string): LicenseStatus {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const raw = fs.readFileSync(filePath, 'utf8')
      return this.loadFromString(raw)
    } catch (e) {
      this.lastError = `读取文件失败: ${errMsg(e)}`
      return this.buildStatus(false)
    }
  }

  /** 从字符串加载并验签 */
  loadFromString(content: string): LicenseStatus {
    let file: LicenseFile
    try {
      file = JSON.parse(content) as LicenseFile
    } catch (e) {
      this.lastError = `JSON 解析失败: ${errMsg(e)}`
      return this.buildStatus(false)
    }

    // 1. 必填字段检查（v1 字段集始终必填；updates_until 可选，存在则必须合法）
    const missing = SIGN_FIELDS_V1.filter((k) => (file as unknown as Record<string, unknown>)[k] === undefined)
    if (missing.length > 0) {
      this.lastError = `License 缺少字段: ${missing.join(', ')}`
      return this.buildStatus(false)
    }
    if (
      file.updates_until !== undefined &&
      !(typeof file.updates_until === 'number' && Number.isFinite(file.updates_until))
    ) {
      this.lastError = 'License 的 updates_until 字段无效（应为时间戳）'
      return this.buildStatus(false)
    }

    const payload: LicensePayload = {
      version: file.version,
      license_id: file.license_id,
      owner: file.owner,
      issued_at: file.issued_at,
      expires_at: file.expires_at,
      ...(file.updates_until !== undefined ? { updates_until: file.updates_until } : {}),
      plan: file.plan,
      features: file.features,
      // 必须参与规范化签名（SIGN_FIELDS_V1/V2 都含此字段）；缺省按空串处理 = 不绑定设备
      disk_fingerprint: String(file.disk_fingerprint ?? '')
    }

    // 2. 签名验证
    const signedData = canonicalize(payload)
    const signatureOk = verifySignature(signedData, file.signature)
    if (!signatureOk) {
      this.lastError = 'License 签名校验失败（文件可能被篡改或公钥不匹配）'
      return this.buildStatus(false)
    }

    // 3. 使用截止检查
    const now = Date.now()
    const expired = now > payload.expires_at
    if (expired) {
      this.lastError = `License 已于 ${new Date(payload.expires_at).toLocaleString('zh-CN')} 过期`
      // 过期 license 不写入 current：否则 getStatus/hasFeature 会把它当有效授权。
      // 但保留在 expiredPayload 里，重启后仍能向 UI 说明「已过期」而不是「未激活」。
      this.current = null
      this.expiredPayload = payload
      // 已过使用截止但仍在本机合法：把它的更新期记入高水位（设备绑定必须匹配，
      // 避免把别台机器的许可证算到这台头上）。
      if (this.fingerprintMatches(payload)) this.rememberUpdates(payload)
      return this.buildStatus(false, payload, expired)
    }

    // 4. 设备绑定检查：license 声明了硬盘指纹时，必须与 APP_ROOT 所在硬盘一致
    //    （同一 U 盘插任意电脑都通过；复制 license 到别的硬盘则拒绝）
    const bound = String(payload.disk_fingerprint ?? '').trim().toLowerCase()
    if (bound) {
      const localFp = getDiskFingerprint()
      if (!localFp || localFp !== bound) {
        this.lastError = `License 与当前硬盘不匹配（本机指纹: ${localFp ?? '无法读取'}），请联系卖家换绑`
        // 同上：绑定不匹配的 license 不得进入 current（避免换盘后仍享授权）
        this.current = null
        this.expiredPayload = null
        return this.buildStatus(false, payload)
      }
    }

    // 全部通过
    this.current = payload
    this.expiredPayload = null
    this.lastError = null
    // 老用户升级到本版本时，用当前许可证初始化本机高水位；之后清除许可证也不会退回免费态。
    this.rememberUpdates(payload)
    return this.buildStatus(true, payload, false)
  }

  /** 返回当前 License 状态（不触发验签）；§393：运行时重判 expires_at */
  getStatus(): LicenseStatus {
    if (this.current && Date.now() > this.current.expires_at) {
      this.expiredPayload = this.current
      this.current = null
      this.lastError = `License 已于 ${new Date(this.expiredPayload.expires_at).toLocaleString('zh-CN')} 过期`
    }
    if (this.current) return this.buildStatus(true, this.current, false)
    if (this.expiredPayload) return this.buildStatus(false, this.expiredPayload, true)
    return this.buildStatus(false, undefined, false)
  }

  /** 清除当前 License */
  clear(): void {
    this.current = null
    this.expiredPayload = null
    this.lastError = null
    // 注意：不清本机更新期高水位——清除许可证不应让人重新获得更新权益。
  }

  /** 许可证声明的硬盘指纹是否与本机一致（未绑定 = 一致） */
  private fingerprintMatches(payload: LicensePayload): boolean {
    const bound = String(payload.disk_fingerprint ?? '').trim().toLowerCase()
    if (!bound) return true
    const localFp = getDiskFingerprint()
    return !!localFp && localFp === bound
  }

  /** 把许可证的更新期抬入本机高水位（只增不减） */
  private rememberUpdates(payload: LicensePayload): void {
    raiseUpdatesWatermark(updatesUntilOf(payload), this.watermarkPath)
  }

  /** 检查某个功能是否解锁；§393：过期即回 false */
  hasFeature(feature: string): boolean {
    if (!this.current || Date.now() > this.current.expires_at) return false
    return this.current.features.includes(feature) || this.current.plan === 'enterprise'
  }

  /** 功能门控：无 License 时返回 free 级别 */
  private buildStatus(
    valid: boolean,
    payload?: LicensePayload,
    expired = false
  ): LicenseStatus {
    // 有效更新期 = max(许可证自带更新期, 本机高水位)。没有许可证但本机记录过更新期时，
    // 仍按记录判定——这正是「清除许可证/文件丢失后不回到免费更新态」的落点。
    const updatesUntil = effectiveUpdatesUntil(
      payload ? updatesUntilOf(payload) : undefined,
      this.watermarkPath
    )
    return {
      valid,
      payload,
      error: valid ? undefined : this.lastError ?? '未找到有效 License',
      signatureOk: valid || this.lastError?.includes('签名校验失败') !== true && payload !== undefined,
      expired,
      updatesUntil,
      // 停更不停用：更新期只影响更新通道，不参与 hasFeature / 数量门控
      updatesExpired: updatesUntil !== undefined && Date.now() > updatesUntil
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
      `免费版最多创建 ${LITE_LIMITS.assistants} 个助手，激活专业版后解除限制（设置 → 授权与路径）`
    )
  }
}

export function assertCanCreateKb(count: number): void {
  if (isPaidPlan()) return
  if (count >= LITE_LIMITS.knowledgeBases) {
    throw new Error(
      `免费版最多创建 ${LITE_LIMITS.knowledgeBases} 个知识库，激活专业版后解除限制（设置 → 授权与路径）`
    )
  }
}
