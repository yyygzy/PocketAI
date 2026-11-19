// 模型级「关闭思考模式」开关（v78 第 4 批产品化项）
//
// 背景：Qwen3 / QwQ 等模型默认开启思考（DashScope 的 `enable_thinking`），一次回答的
// 思考 token 也计入输出预算，既费钱又慢。参数管线已经打通（ChatParams.enableThinking →
// 请求体 `enable_thinking`），但此前只能通过助手 defaultParams 手写，普通用户够不着。
// 这里补一个**模型级**开关：用户点名关掉某台模型的思考，引擎/普通对话下一轮就不下发
// `enable_thinking`（→ false），把默认行为交还给用户。
//
// 只存"显式关闭"的清单（不存 true）：服务端默认本来就开着，存 true 没有意义；
// 用户取消开关＝从清单移除＝回到服务端默认。与 text_protocol_models 同构（单键 JSON 数组）。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { isThinkingCapableModel } from '../../shared/thinking-models'

const K_THINKING_DISABLED_MODELS = 'agent.thinking_disabled_models'

/** 清单上限：与文本协议同一档，只防脏值撑大 KV */
export const MAX_THINKING_DISABLED_MODELS = 200

/** 单个 id 片段长度上限（providerId 是 UUID、model 名实测远小于此） */
const MAX_PART_CHARS = 128

/** 开关的键：`providerId::model`（与窗口/文本协议/单价表同形，便于用户对照） */
export function thinkingDisabledKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/** 清洗：只留 `非空::非空` 的字符串项、去重、截断；脏 JSON 一律当空列表 */
export function normalizeThinkingDisabledModels(raw: unknown): string[] {
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
    const key = thinkingDisabledKey(providerId, model)
    if (!out.includes(key)) out.push(key)
  }
  return out.slice(0, MAX_THINKING_DISABLED_MODELS)
}

/** 当前被显式关闭思考的模型键（只读，不写回） */
export function listThinkingDisabledModels(): string[] {
  const raw = appConfigRepo.get(K_THINKING_DISABLED_MODELS)
  if (!raw) return []
  try {
    return normalizeThinkingDisabledModels(JSON.parse(raw))
  }
  catch {
    return []
  }
}

/** 该 provider+model 是否被用户显式关闭思考（引擎每轮开始读一次） */
export function isThinkingDisabled(providerId: string, model: string): boolean {
  if (!providerId || !model) return false
  return listThinkingDisabledModels().includes(thinkingDisabledKey(providerId, model))
}

/**
 * 开/关某台模型的思考，返回最新清单（渲染层以此为准，不做本地乐观更新）。
 * 非法输入（空 id、id 含 `::`、超长）直接拒绝并返回当前清单——否则会存进永远匹配不上的键，
 * 用户看到的就是"点了开关没反应"（与 text-protocol-prefs 同一口径）。
 */
export function setThinkingDisabled(
  providerId: string,
  model: string,
  disabled: boolean
): string[] {
  const p = String(providerId ?? '').trim()
  const m = String(model ?? '').trim()
  const current = listThinkingDisabledModels()
  if (!p || !m || p.includes('::') || p.length > MAX_PART_CHARS || m.length > MAX_PART_CHARS) {
    return current
  }
  const key = thinkingDisabledKey(p, m)
  const next = disabled
    ? normalizeThinkingDisabledModels([...current, key])
    : current.filter((k) => k !== key)
  if (JSON.stringify(next) === JSON.stringify(current)) return current
  appConfigRepo.set(K_THINKING_DISABLED_MODELS, JSON.stringify(next))
  return next
}

/**
 * 直接给 ChatParams 的片段：关闭时下发 `enableThinking: false`，未关闭时不带该字段。
 *
 * 两道闸：①用户没点名关闭 ⇒ 不出现该字段（不认识的端点因多余字段 400）；
 * ②模型本身不认 enable_thinking（OpenAI/Gemini/Claude 等）⇒ 即使点了也**不出现**。
 * 第二道是硬约束：能力判定与下发判定必须同一份，否则 UI 一点就把别家模型打挂。
 */
export function thinkingParamFor(
  providerId: string,
  model: string
): { enableThinking?: false } {
  if (!isThinkingCapableModel(model)) return {}
  return isThinkingDisabled(providerId, model) ? { enableThinking: false } : {}
}
