// 每台模型可选的「备用 target」（V4-Iter-237）
//
// 一句话：这台模型连续重试都没答上来时，允许按用户预设换**一次**另一台。
// 刻意不叫"路由"也不叫"fallback 链"——只有一次机会、只在主干 run、只在重试耗尽那一档触发。
// 换成一条链会把三件我们量过的事变模糊：谁在答（归因）、这台卡不卡这张显存（§140 那套容量算术）、
// 以及"换一台能不能真救"（401／没配 Key 换台云的可能救，上下文溢出换台窗口更小的反而更糟）。
//
// 存储沿用「模型级偏好」那一族：app_config 单键 + `providerId::model`（见 `shared/fallback-target.ts`）。
// 拒绝原因只回码（口径同 §152 的委派开关与 §234 的窗口）：句子由界面按语言拼。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import {
  fallbackTargetKey,
  isFallbackPart,
  normalizeFallbackTargets,
  type FallbackTarget
} from '../../shared/fallback-target'

export { FALLBACK_MAX_ENTRIES, fallbackTargetKey, type FallbackTarget } from '../../shared/fallback-target'

const K_FALLBACK_TARGETS = 'agent.fallback_targets'

export type FallbackRejection = 'FALLBACK_INVALID_ID' | 'FALLBACK_IS_SELF' | 'FALLBACK_INVALID_TARGET'

/** 全部备用（只读，不写回）；脏 JSON 退成空表而不是抛错 */
export function listFallbackTargets(): Record<string, FallbackTarget> {
  const raw = appConfigRepo.get(K_FALLBACK_TARGETS)
  if (!raw) return {}
  try {
    return normalizeFallbackTargets(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** 这台模型的备用；没设过／指向自己 ⇒ null（引擎据此一句都不换） */
export function getFallbackTarget(providerId: string, model: string): FallbackTarget | null {
  if (!providerId || !model) return null
  return listFallbackTargets()[fallbackTargetKey(providerId, model)] ?? null
}

/** 只清一台的备用（键不在表里就原样返回，不写库） */
function withoutKey(targets: Record<string, FallbackTarget>, key: string): Record<string, FallbackTarget> {
  const next: Record<string, FallbackTarget> = {}
  for (const [k, v] of Object.entries(targets)) if (k !== key) next[k] = v
  return next
}

/**
 * 设／清某台模型的备用。`target === null` 表示清除（回到"没备用"）。
 * 非法输入一律不改库：宁可回一句"这台不行"，也不要存进去让引擎换到一台不存在的模型上
 * （那是"看起来兜住了、其实每次都失败"的形状）。
 */
export function setFallbackTarget(
  providerId: string,
  model: string,
  target: { providerId: string; model: string } | null
): { targets: Record<string, FallbackTarget>; rejected?: FallbackRejection } {
  const targets = listFallbackTargets()
  const p = typeof providerId === 'string' ? providerId.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (!isFallbackPart(p) || !isFallbackPart(m)) return { targets, rejected: 'FALLBACK_INVALID_ID' }
  const key = fallbackTargetKey(p, m)
  if (target === null) {
    if (!(key in targets)) return { targets }
    const next = withoutKey(targets, key)
    appConfigRepo.set(K_FALLBACK_TARGETS, JSON.stringify(next))
    return { targets: next }
  }
  const tp = typeof target.providerId === 'string' ? target.providerId.trim() : ''
  const tm = typeof target.model === 'string' ? target.model.trim() : ''
  if (!isFallbackPart(tp) || !isFallbackPart(tm)) return { targets, rejected: 'FALLBACK_INVALID_TARGET' }
  if (tp === p && tm === m) return { targets, rejected: 'FALLBACK_IS_SELF' }
  const next = normalizeFallbackTargets({ ...targets, [key]: { providerId: tp, model: tm } })
  // 归一化把这条丢掉了 ⇒ 说明它撞了上限：不能演成"设好了"
  if (!next[key]) return { targets, rejected: 'FALLBACK_INVALID_TARGET' }
  appConfigRepo.set(K_FALLBACK_TARGETS, JSON.stringify(next))
  return { targets: next }
}
