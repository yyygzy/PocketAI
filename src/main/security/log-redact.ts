// 日志脱敏与长文本封顶（SEC-14）
//
// 为什么单独成模块：logger.ts 顶层 import electron `app`，把纯逻辑放这里才能被单测直接覆盖。
//
// 背景：日志目录在便携盘（data/logs），一旦把凭据或整段模型回复/文档正文写进去，
// 丢的是 U 盘就等于泄密。默认级别打包后是 info，但 info 级别的调用同样可能带结构体参数，
// 因此这里按「键名 + 长度」两道封顶，而不是靠调用方自觉。
//
// 取舍：值形态不做智能识别（长随机串也可能是普通 ID），只认键名——宁可少脱敏一点，
// 也不要把业务数据打码到无法排障；长文本一律按长度截断，兜住「整段正文进日志」这条主路径。

/** 命中即整值替换的键名（大小写不敏感，含常见变体） */
export const SENSITIVE_LOG_KEY_RE =
  /authorization|proxy-authorization|api[_-]?key|apikey|token|secret|password|passwd|credential|cookie|set-cookie|private[_-]?key|access[_-]?key|session[_-]?id/i

/** 占位文案（不保留任何前缀/长度，避免从占位反推原值特征） */
export const REDACTED_PLACEHOLDER = '[redacted]'

/** 单条字符串在日志里的长度上限 */
export const MAX_LOG_STRING_CHARS = 2000

/** 递归深度上限：与 logger 的 inspect(depth: 4) 对齐，超深结构交给 inspect 自身处理 */
const MAX_DEPTH = 4

/** 超长字符串截断（含原长提示，便于排障时判断是否被截） */
export function capLogString(s: string): string {
  if (s.length <= MAX_LOG_STRING_CHARS) return s
  return `${s.slice(0, MAX_LOG_STRING_CHARS)}…[已截断，原长 ${s.length} 字符]`
}

/**
 * 结构化脱敏（纯函数）：递归处理普通对象/数组，命中敏感键名的值整体替换；
 * Error/Date/Buffer/Map/Set 等非普通对象原样保留（由 inspect 自行格式化），
 * 循环引用替换为 [Circular]。
 */
export function redactLogValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof value === 'string') return capLogString(value)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) {
    return value instanceof Error ? capLogString(value.stack ?? `${value.name}: ${value.message}`) : value
  }
  if (depth >= MAX_DEPTH) return '[depth-limit]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((v) => redactLogValue(v, seen, depth + 1))
  // Map/Set/TypedArray 等：不拆解结构（拆了反而丢信息），交给 inspect 原样输出
  if (value instanceof Map || value instanceof Set) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_LOG_KEY_RE.test(k) ? REDACTED_PLACEHOLDER : redactLogValue(v, seen, depth + 1)
  }
  return out
}
