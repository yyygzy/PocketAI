// 每台模型「出问题时换哪一台」这一个输入（V4-Iter-237）
//
// 为什么不是通用模型路由：单机、本地优先、选择稳定、量小 ⇒ 多一跳路由与新故障点不划算
// （这条依据来自行业对照里"不适用条件"那一节，见台账 §237 来由）。所以只做一件窄事：
// **同一台重试耗尽之后，按用户预设换一次**，并且在界面明说换了谁。
//
// 存储形状沿用「模型级偏好」那一族（`model-window.ts` / text-protocol / delegate-prefs）：
// app_config 单键 + `providerId::model` 键，不建新表、不引入新持久化格式。
// 键两侧共用同一把尺子：主进程拿它拒绝脏值，渲染层拿它做校验与文案里的数字（§153 那条"不手抄"同轴）。

/** 一台备用落点：provider ＋ 模型名，与 ChatTarget 同形但**不带** params（换的是"谁答"，不是"怎么答"） */
export interface FallbackTarget {
  providerId: string
  model: string
}

/** 条目上限：一个实例里被点名过的模型不会多，超限只防脏值灌进 app_config */
export const FALLBACK_MAX_ENTRIES = 200

/** 单段长度上限（与 model-window 的 `MAX_PART_CHARS` 同一档） */
export const FALLBACK_MAX_PART_CHARS = 128

/** 键：`providerId::model`——用户在「窗口」「备用」两处看到的是同一个键形状 */
export function fallbackTargetKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/** 一段 id／模型名可用的形状？（空、含 `::`、超长都不行——含 `::` 会让键拆回时错位） */
export function isFallbackPart(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !value.includes('::') &&
    value.trim().length <= FALLBACK_MAX_PART_CHARS
  )
}

/** 一张合法的备用表：脏键、脏值、指向自己的那一条统统丢掉（坏 JSON 退成空表，不抛） */
export function normalizeFallbackTargets(raw: unknown): Record<string, FallbackTarget> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, FallbackTarget> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const i = key.indexOf('::')
    if (i < 0) continue
    const providerId = key.slice(0, i).trim()
    const model = key.slice(i + 2).trim()
    if (!isFallbackPart(providerId) || !isFallbackPart(model)) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (!isFallbackPart(v.providerId) || !isFallbackPart(v.model)) continue
    const next = { providerId: (v.providerId as string).trim(), model: (v.model as string).trim() }
    // 指回自己不是一条备用：换完还是同一台，白多一跳还让用户以为兜住了
    if (next.providerId === providerId && next.model === model) continue
    out[fallbackTargetKey(providerId, model)] = next
    if (Object.keys(out).length >= FALLBACK_MAX_ENTRIES) break
  }
  return out
}
