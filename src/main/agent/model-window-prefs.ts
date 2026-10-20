// 每台模型可选的「上下文窗口」输入（V4-Iter-234，§232 流水账拆出来的那一条）
//
// 为什么要有这个数：Agent 每轮带多少历史，今天是用「30 条」当尺子量一个「token」的问题。
// 条数对工具密集的会话根本不成比例（一条工具结果最多 2000 字符 ≈ 500–2500 token），
// 30 条堆起来能超过小窗口模型的容量；反过来 200k 上下文的云模型又被条数白白卡住。
// 换成按 token 预算裁，缺的那个输入就是「这台模型能装多少」——本模块只存这个输入。
//
// 存储形状沿用「模型级开关」那一族（text-protocol-prefs / delegate-prefs）：
// app_config 单键 + `providerId::model` 键，不建新表、不引入新持久化格式。
// 留空=未设（与用量预算 getUsageBudgetDaily 的"空即未设"同义），未设时引擎走原来的 30 条。
//
// ⚠️ 这个数只决定墨匣每轮发多少历史，**不会替用户改服务端的 num_ctx**：
// 本地端点仍按它自己的配置服务，填得比实际大，超出的部分由服务端悄悄截断（界面那句话就是写给这件事的）。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import {
  MODEL_WINDOW_MAX_ENTRIES,
  isModelWindowTokens,
  modelWindowKey
} from '../../shared/model-window'

export { MODEL_WINDOW_MAX_ENTRIES, modelWindowKey } from '../../shared/model-window'

const K_MODEL_CONTEXT_WINDOWS = 'agent.model_context_windows'

const MAX_PART_CHARS = 128

export type ModelWindowMap = Record<string, number>

/** 拒绝原因只回码（口径同 §152 的委派开关：句子由界面按语言拼） */
export type ModelWindowRejection = 'MODEL_WINDOW_INVALID_ID' | 'MODEL_WINDOW_INVALID_VALUE'

/** 清洗：键必须是 `非空::非空`、值必须是范围内的整数；脏 JSON 一律当空表 */
export function normalizeModelWindows(raw: unknown): ModelWindowMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ModelWindowMap = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const i = key.indexOf('::')
    if (i < 0) continue
    const providerId = key.slice(0, i).trim()
    const model = key.slice(i + 2).trim()
    if (!providerId || !model) continue
    if (providerId.length > MAX_PART_CHARS || model.length > MAX_PART_CHARS) continue
    if (!isModelWindowTokens(value)) continue
    out[modelWindowKey(providerId, model)] = value
    if (Object.keys(out).length >= MODEL_WINDOW_MAX_ENTRIES) break
  }
  return out
}

/** 全部已声明的窗口（只读，不写回）；脏值/坏 JSON 退成空表而不是抛错 */
export function listModelContextWindows(): ModelWindowMap {
  const raw = appConfigRepo.get(K_MODEL_CONTEXT_WINDOWS)
  if (!raw) return {}
  try {
    return normalizeModelWindows(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** 这台模型声明的窗口 token 数；未声明返回 null（引擎据此退回 30 条口径） */
export function getModelContextWindow(providerId: string, model: string): number | null {
  if (!providerId || !model) return null
  return listModelContextWindows()[modelWindowKey(providerId, model)] ?? null
}

/**
 * 设/清一台模型的上下文窗口。`tokens === null` 表示清除（回到"未设"）。
 * 返回最新表 + 拒绝码；**不做本地乐观更新**，调用方以回传的表为准。
 * 非法输入一律不改库：宁可回一句"这个数不行"，不要存进去再让引擎永远匹配不上。
 */
export function setModelContextWindow(
  providerId: string,
  model: string,
  tokens: number | null
): { windows: ModelWindowMap; rejected?: ModelWindowRejection } {
  const windows = listModelContextWindows()
  const p = String(providerId ?? '').trim()
  const m = String(model ?? '').trim()
  if (!p || !m || p.includes('::') || p.length > MAX_PART_CHARS || m.length > MAX_PART_CHARS) {
    return { windows, rejected: 'MODEL_WINDOW_INVALID_ID' }
  }
  const key = modelWindowKey(p, m)
  if (tokens === null) {
    if (!(key in windows)) return { windows }
    const next: ModelWindowMap = {}
    for (const [k, v] of Object.entries(windows)) if (k !== key) next[k] = v
    appConfigRepo.set(K_MODEL_CONTEXT_WINDOWS, JSON.stringify(next))
    return { windows: next }
  }
  if (!isModelWindowTokens(tokens)) {
    return { windows, rejected: 'MODEL_WINDOW_INVALID_VALUE' }
  }
  if (windows[key] === tokens) return { windows }
  const next = normalizeModelWindows({ ...windows, [key]: tokens })
  appConfigRepo.set(K_MODEL_CONTEXT_WINDOWS, JSON.stringify(next))
  return { windows: next }
}
