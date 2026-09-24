// Agent 助手 defaultParams 安全过滤：仅透传白名单内的生成参数，
// 防止第三方扩展助手注入 tools/toolChoice/stream/messages/model/signal 等控制面字段。

/** Agent 允许助手 defaultParams 透传的生成参数白名单 */
const SAFE_DEFAULT_PARAM_KEYS = new Set([
  'temperature',
  'maxTokens',
  'topP',
  'frequencyPenalty',
  'presencePenalty'
])

/** 从助手 defaultParams 中仅挑出白名单内的生成参数 */
export function pickSafeParams(params: Record<string, unknown> | null): Record<string, unknown> {
  if (!params) return {}
  const out: Record<string, unknown> = {}
  for (const k of SAFE_DEFAULT_PARAM_KEYS) {
    if (k in params) out[k] = params[k]
  }
  return out
}
