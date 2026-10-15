// 模型级「允许顺序委派」开关（决策③，2026-10-15 用户选定：一律不开，手动控制）
//
// 为什么不自动开：142 的探针已经能判出"这台模型派得出活"，但**判得出活 ≠ 该派活**——
// 一次编排是 3 角色 × 若干步的 LLM 调用总量（本机 4GiB 实测单次委派热态 1.34s、
// 而一次探测 3 发就要 8–18 秒），默认打开等于替用户花掉他没打算花的显存与时间。
// 所以这里与「走文本协议」同构：**默认关**，用户点名某台模型才开，系统只负责把信息给足。
//
// 存储：app_config 单键 JSON 数组，元素形如 `providerId::model`（不建新表、不引新文件格式）。
//
// 关键口径：**开关本身不含"能力"判断，但写它的那一处含**——
// 前置条件（探针必须判出 native_tools_ok 且未过期）在 `delegate-capability.setDelegationEnabled`
// 里 enforced，本模块只存"用户点名了哪些模型"。引擎每轮只读 `isDelegationEnabledFor`，
// 于是"能不能派活"只有一个判定点（142 的落库），"开没开"也只有一个判定点（这里）。
import { appConfigRepo } from '../db/repositories/app-config.repo'

const K_DELEGATE_ENABLED_MODELS = 'agent.delegate_enabled_models'

/** 列表上限：真被点名开委派的模型不会多；超限只防脏值把 KV 撑大 */
export const MAX_DELEGATE_ENABLED_MODELS = 200

const MAX_PART_CHARS = 128

/** 键形如 `providerId::model`，与文本协议开关、委派能力判定同一个形状 */
export function delegateEnabledKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/** 清洗：只留 `非空::非空`、去重、截断；脏 JSON 一律当空列表（= 全关） */
export function normalizeDelegateEnabledModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const i = x.indexOf('::')
    if (i < 0) continue
    const providerId = x.slice(0, i).trim()
    const model = x.slice(i + 2).trim()
    if (!providerId || !model) continue
    if (providerId.length > MAX_PART_CHARS || model.length > MAX_PART_CHARS) continue
    const key = delegateEnabledKey(providerId, model)
    if (!out.includes(key)) out.push(key)
  }
  return out.slice(0, MAX_DELEGATE_ENABLED_MODELS)
}

export function listDelegationEnabledModels(): string[] {
  const raw = appConfigRepo.get(K_DELEGATE_ENABLED_MODELS)
  if (!raw) return []
  try {
    return normalizeDelegateEnabledModels(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 引擎每轮开始读一次：这台模型允许把任务派给子代理吗（默认 false） */
export function isDelegationEnabledFor(providerId: string, model: string): boolean {
  if (!providerId || !model) return false
  return listDelegationEnabledModels().includes(delegateEnabledKey(providerId, model))
}

/**
 * 写开关（唯一写入方；调用前必须已通过能力前置检查）。
 * 非法输入（空、含 `::`、超长）一律拒绝并原样返回当前列表——
 * 存进 `::m` 这种永远匹配不上的键，用户看到的就是"点了开关没反应"。
 */
export function writeDelegationEnabledModels(keys: string[]): string[] {
  const next = normalizeDelegateEnabledModels(keys)
  appConfigRepo.set(K_DELEGATE_ENABLED_MODELS, JSON.stringify(next))
  return next
}

/** 供能力模块做增删：返回最新列表 */
export function addOrRemoveDelegationEnabled(providerId: string, model: string, on: boolean): string[] {
  const current = listDelegationEnabledModels()
  const p = String(providerId ?? '').trim()
  const m = String(model ?? '').trim()
  if (!p || !m || p.includes('::') || p.length > MAX_PART_CHARS || m.length > MAX_PART_CHARS) return current
  const key = delegateEnabledKey(p, m)
  return writeDelegationEnabledModels(on ? [...current, key] : current.filter((k) => k !== key))
}
