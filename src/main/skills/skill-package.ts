// 技能包完整性（P2-3 第一刀）：导出写入校验和，导入按校验和验完整性。
//
// 口径必须先说清：**校验和只证明「内容与导出时一致」，不证明「来源可信」**。
// 它与签名不是一回事——界面文案不许写成「已签名 / 可信来源」，
// 否则用户会把「没被改过」误读成「作者身份已验证」，那正是供应链风险的放大器。
//
// 覆盖字段固定为 name/description/icon/content/category/tags：
//  · 不含 exportedAt / version —— 同一技能重复导出必须得到同一个值；
//  · category/tags 缺省归一为 '' / [] —— 老导出没有这两个键，导出端也只在非空时写，
//    归一后两边算出来的值才可比；
//  · 序列化按固定顺序重建对象，包内字段顺序不同不影响结果。
import { createHash } from 'node:crypto'

export const SKILL_PACKAGE_FORMAT = 'pocketai-skill'
export const SKILL_PACKAGE_VERSION = 1
/** 当前只认 sha256；其它算法一律拒绝（无法验证就等于没验证） */
export const SKILL_CHECKSUM_ALGO = 'sha256'

/** 参与校验和的字段（与导出 payload 的 skill 子对象同形） */
export interface SkillChecksumFields {
  name: string
  description: string
  icon: string
  content: string
  category?: string
  tags?: string[]
}

export interface SkillChecksum {
  algo: string
  value: string
}

/** 归一化 + 固定顺序序列化：这是校验和的唯一口径，导出与导入必须共用一个函数 */
function canonicalize(fields: SkillChecksumFields): string {
  return JSON.stringify({
    schema: 'pocketai-skill/1',
    name: String(fields.name ?? ''),
    description: String(fields.description ?? ''),
    icon: String(fields.icon ?? ''),
    content: String(fields.content ?? ''),
    category: String(fields.category ?? ''),
    tags: Array.isArray(fields.tags) ? fields.tags.map((t) => String(t)) : []
  })
}

/** 计算 sha256 校验和 */
export function computeSkillChecksum(fields: SkillChecksumFields): SkillChecksum {
  return {
    algo: SKILL_CHECKSUM_ALGO,
    value: createHash('sha256').update(canonicalize(fields), 'utf8').digest('hex')
  }
}

export interface SkillExportPayload {
  format: string
  version: number
  exportedAt: string
  checksum: SkillChecksum
  skill: {
    name: string
    description: string
    icon: string
    content: string
    category?: string
    tags?: string[]
  }
}

/**
 * 构造导出载荷。旧版本导出/导入的文件形状保持不变：
 * 空 category/tags 不落键（校验和仍按归一口径算，读回来能对上）。
 */
export function buildSkillExportPayload(
  skill: SkillChecksumFields,
  exportedAt: string = new Date().toISOString()
): SkillExportPayload {
  const category = String(skill.category ?? '')
  const tags = Array.isArray(skill.tags) ? skill.tags.map((t) => String(t)) : []
  return {
    format: SKILL_PACKAGE_FORMAT,
    version: SKILL_PACKAGE_VERSION,
    exportedAt,
    checksum: computeSkillChecksum({ ...skill, category, tags }),
    skill: {
      name: String(skill.name ?? ''),
      description: String(skill.description ?? ''),
      icon: String(skill.icon ?? ''),
      content: String(skill.content ?? ''),
      ...(category ? { category } : {}),
      ...(tags.length > 0 ? { tags } : {})
    }
  }
}

/** 校验结果：absent＝本来就没有校验和（老包/Markdown），不阻断但要说出来 */
export type SkillPackageVerification =
  | { state: 'absent' }
  | { state: 'ok'; checksum: SkillChecksum }
  | { state: 'mismatch'; expected: string; actual: string }
  | { state: 'unsupported'; reason: string }

function pickString(rec: Record<string, unknown>, key: string): string {
  return typeof rec[key] === 'string' ? (rec[key] as string) : ''
}

/**
 * 校验技能包文本里的校验和。
 * - 非 JSON（Markdown 技能）与坏 JSON → absent：格式判定交给 parseSkillText；
 * - 有 checksum 但算法/形态不认识 → unsupported（拒绝，不能当没看见）；
 * - 校验不一致 → mismatch（拒绝）。
 */
export function verifySkillPackage(text: string): SkillPackageVerification {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'absent' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'absent' }
  const obj = parsed as Record<string, unknown>

  const rawChecksum = obj.checksum
  if (rawChecksum === undefined || rawChecksum === null) return { state: 'absent' }
  if (typeof rawChecksum !== 'object' || Array.isArray(rawChecksum)) {
    return { state: 'unsupported', reason: 'checksum 字段不是对象' }
  }
  const c = rawChecksum as Record<string, unknown>
  const algo = typeof c.algo === 'string' ? c.algo.trim().toLowerCase() : ''
  const value = typeof c.value === 'string' ? c.value.trim().toLowerCase() : ''
  if (algo !== SKILL_CHECKSUM_ALGO) {
    return { state: 'unsupported', reason: `不支持的校验算法：${algo || '空'}` }
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return { state: 'unsupported', reason: '校验和格式不正确' }
  }

  // 标准包按 skill 子对象算，扁平包按顶层算——与 parseSkillJson 的两条分支对齐
  const source =
    obj.skill && typeof obj.skill === 'object' && !Array.isArray(obj.skill)
      ? (obj.skill as Record<string, unknown>)
      : obj
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((t): t is string => typeof t === 'string')
    : []
  const actual = computeSkillChecksum({
    name: pickString(source, 'name'),
    description: pickString(source, 'description'),
    icon: pickString(source, 'icon'),
    content: pickString(source, 'content'),
    category: pickString(source, 'category'),
    tags
  })
  if (actual.value !== value) {
    return { state: 'mismatch', expected: value, actual: actual.value }
  }
  return { state: 'ok', checksum: actual }
}
