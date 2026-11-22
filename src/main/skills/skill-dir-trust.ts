// 远程技能目录包的清单签名验签（供应链加固）。
//
// 背景：现有 manifest 只做逐文件 sha256/md5 校验——那证明"下载到的字节与清单一致"，
// 但清单本身谁发的、有没有被改过没有信任锚。这里给清单加可选 Ed25519 签名：
//  - manifest 可带 `signature`（base64url 64 字节），签的是"去掉 signature 后的 manifest
//    规范 JSON"（递归键排序，与 MCP catalog 共用同一套 canonicalJson）；
//  - 公钥**不放在 manifest 里自报**，由 registry 索引条目随 HTTPS 拉取提供（`publicKey`）；
//    信任锚是 registry 索引本身（已有 HTTPS + 站点策略），不是被验的对象；
//  - 没签名的清单继续放行（老仓库零破坏），但安装回执标记 signed:false 供 UI 提示；
//    一旦带签名就必须验过（fail-closed），签名坏/公钥坏/不匹配都拒绝安装。
import { verify as cryptoVerify } from 'node:crypto'
import { canonicalJson } from '../../shared/mcp-catalog-trust'
import { normalizeEd25519PublicKey } from '../mcp/catalog-trust-keys'
import type { SkillDirManifest } from './skill-remote-dir'

/** 清单上可选签名字段；解析阶段从原始 JSON 读取，不进 SkillDirManifest 主体 */
export const SKILL_DIR_SIGNATURE_FIELD = 'signature'

const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/

export interface SkillDirTrustResult {
  /** 清单是否声明了签名 */
  signed: boolean
  /** 有签名且验过：true；无签名：false（不阻断） */
  verified: boolean
  error?: string
}

/**
 * 校验 manifest 签名。
 * @param rawManifest 原始清单 JSON 文本（解析前的字符串，避免重序列化丢字段）
 * @param manifest 已解析的清单主体
 * @param publisherPublicKey registry 索引条目提供的发布者 Ed25519 公钥（PEM / base64 raw / SPKI）
 */
export function verifySkillDirManifestSignature(
  rawManifest: string,
  manifest: SkillDirManifest,
  publisherPublicKey?: string
): SkillDirTrustResult {
  let raw: unknown
  try {
    raw = JSON.parse(rawManifest)
  } catch {
    return { signed: false, verified: false, error: '清单不是合法 JSON，无法验签' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { signed: false, verified: false, error: '清单不是对象，无法验签' }
  }
  const obj = raw as Record<string, unknown>
  const signature = obj[SKILL_DIR_SIGNATURE_FIELD]
  if (signature === undefined || signature === null || signature === '') {
    // 未签名：向后兼容放行，但如实标记
    return { signed: false, verified: false }
  }
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    return { signed: true, verified: false, error: '清单签名格式不正确' }
  }
  if (!publisherPublicKey || !publisherPublicKey.trim()) {
    return {
      signed: true,
      verified: false,
      error: '该技能清单带签名，但索引未提供发布者公钥，已拒绝安装'
    }
  }

  let pem: string
  try {
    pem = normalizeEd25519PublicKey(publisherPublicKey).pem
  } catch (e) {
    return { signed: true, verified: false, error: `发布者公钥无法解析：${(e as Error).message}` }
  }

  // 签名覆盖除去 signature 字段的整份清单（不是只签 files，防止 entry/format 被替换）
  const { [SKILL_DIR_SIGNATURE_FIELD]: _sig, ...unsigned } = obj
  const signingInput = canonicalJson(unsigned)
  let ok = false
  try {
    ok = cryptoVerify(null, Buffer.from(signingInput, 'utf8'), pem, Buffer.from(signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) {
    return { signed: true, verified: false, error: '清单签名校验失败：内容与签名不一致，已拒绝安装' }
  }
  // 防御：签名验过的必须是同一份被解析的清单主体（避免解析/验签用了不同文本）
  if (manifest.entry !== (unsigned as { entry?: unknown }).entry) {
    return { signed: true, verified: false, error: '清单验签主体与解析结果不一致，已拒绝安装' }
  }
  return { signed: true, verified: true }
}
