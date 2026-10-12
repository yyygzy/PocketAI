// 模型级「走文本协议」开关（§4.4-⑦，2026-10-12 决策）
//
// 背景：有的端点（Ollama / 部分本地量化模型）**不报 400、只是静默忽略 tools**，
// 于是引擎里那条"报错才降级"的自动切换永远不触发，Agent 在这类模型上等于无工具。
// 但"有工具却零调用"也可能是模型本轮判断不需要工具——自动降级会给它多跑一步、多花一次调用。
// 所以这里只做**显式开关**：用户点名"这台模型走文本协议"，引擎才首轮就不传 tools；
// 判断权留在用户手里，系统只负责把信息给足（见 engine 的 mcpHeldBack 与零调用提示）。
//
// 存储：app_config 单键 JSON 数组，元素形如 `providerId::model`。
// 不引入新表/新文件格式（与用量预算、pip 源等既有开关同构）。
import { appConfigRepo } from '../db/repositories/app-config.repo'

const K_TEXT_PROTOCOL_MODELS = 'agent.text_protocol_models'

/** 列表上限：一个实例里真被点名走文本协议的模型不会多；超限只防脏值把 KV 撑大 */
export const MAX_TEXT_PROTOCOL_MODELS = 200

/** 单个 id 片段长度上限（providerId 是 UUID、model 名实测远小于此） */
const MAX_PART_CHARS = 128

/** 开关的键：`providerId::model`（与用量单价表 priceKey 同形，便于用户对照） */
export function textProtocolKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/** 清洗：只留 `非空::非空` 的字符串项、去重、截断；脏 JSON 一律当空列表 */
export function normalizeTextProtocolModels(raw: unknown): string[] {
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
    const key = textProtocolKey(providerId, model)
    if (!out.includes(key)) out.push(key)
  }
  return out.slice(0, MAX_TEXT_PROTOCOL_MODELS)
}

/** 当前被点名走文本协议的模型键（只读，不写回） */
export function listTextProtocolModels(): string[] {
  const raw = appConfigRepo.get(K_TEXT_PROTOCOL_MODELS)
  if (!raw) return []
  try {
    return normalizeTextProtocolModels(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 该 provider+model 是否被要求走文本协议（引擎每轮开始读一次） */
export function isTextProtocolForced(providerId: string, model: string): boolean {
  if (!providerId || !model) return false
  return listTextProtocolModels().includes(textProtocolKey(providerId, model))
}

/**
 * 开/关某台模型的文本协议，返回最新列表（渲染层以此为准，不做本地乐观更新）。
 * 空 providerId/model 视为非法输入直接拒绝（返回当前列表，不写库）——
 * 否则会存进 `::m` 这种永远匹配不上的记录，用户看到的就是"点了开关没反应"。
 * providerId 含 `::` 也拒：键会解析成别的形状，往返不一致。
 */
export function setTextProtocolModel(providerId: string, model: string, on: boolean): string[] {
  const p = String(providerId ?? '').trim()
  const m = String(model ?? '').trim()
  const current = listTextProtocolModels()
  if (!p || !m || p.includes('::') || p.length > MAX_PART_CHARS || m.length > MAX_PART_CHARS) return current
  const key = textProtocolKey(p, m)
  const next = on
    ? normalizeTextProtocolModels([...current, key])
    : current.filter((k) => k !== key)
  if (JSON.stringify(next) === JSON.stringify(current)) return current
  appConfigRepo.set(K_TEXT_PROTOCOL_MODELS, JSON.stringify(next))
  return next
}
