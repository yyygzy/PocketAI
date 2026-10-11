// MCP 调用记录的预览文本（写库前先把入参/结果压成一行可排障的摘要）
//
// 为什么必须在这里过一道：MCP 工具的入参与返回值都可能带密钥或整段文档正文，
// 而这张表要长期留在库里（none 模式下 app.db 就是明文）。口径同 SEC-14 的文件日志——
// 敏感键名整值替换、单值定长截断，够排障即可，不做「完整存档」。
// 顺序很讲究：**先打码再截断**，反了会把半截密钥留在库里。
import { REDACTED_PLACEHOLDER, SENSITIVE_LOG_KEY_RE } from '../security/log-redact'

/** 单个值在预览里的长度上限 */
export const MCP_CALL_VALUE_CHARS = 80
/** 入参预览总长度上限 */
export const MCP_CALL_ARGS_PREVIEW_CHARS = 500
/** 结果预览总长度上限（结果通常是正文，比入参长，但仍不该存整段） */
export const MCP_CALL_RESULT_PREVIEW_CHARS = 1200
/** 错误信息长度上限 */
export const MCP_CALL_ERROR_CHARS = 300

/**
 * 自由文本层面的密钥打码：键名形态（`api_key: xxx` / `token=xxx`，值可含 `Bearer …`）
 * 与两种最常见的裸密钥形态（`sk-…` / `Bearer …`）。
 * 键名打码只认结构，server 把密钥写进报错正文时就靠这里兜底。
 */
export function redactStrings(text: string): string {
  return text
    .replace(
      /([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization|access[_-]?key)[A-Za-z0-9_.-]*)\s*[=:]\s*(?:"[^"]*"|'[^']*'|Bearer\s+\S+|[^\s,;]+)/gi,
      `$1=${REDACTED_PLACEHOLDER}`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `Bearer ${REDACTED_PLACEHOLDER}`)
    .replace(/\b(?:sk|pk|ghp|xoxb|AIza)[A-Za-z0-9_-]{8,}\b/g, REDACTED_PLACEHOLDER)
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  // 留一个字符给省略号，保证结果长度严格不超 max
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const json = JSON.stringify(v)
    return json ?? String(v)
  } catch {
    return '[unserializable]'
  }
}

/** 打码窗口倍数：只在「保留长度 × 该倍数」内跑正则 */
const REDACTION_WINDOW_FACTOR = 4

/**
 * 先打码后截断（顺序反了会留下半截密钥）。
 * 但正则不能整段跑：一次 MCP 结果常是几万字符的正文，三条正则在 50k 文本上
 * 会退化到秒级（实测把用例拖到超时）。反正最终只留前 max 个字符，
 * 就把正则窗口限在「保留长度 × 4」内——窗口外的内容本来就要被丢掉。
 */
function maskThenClip(value: unknown, max: number): string {
  const text = stringifyValue(value)
  const window = max > 0 ? text.slice(0, max * REDACTION_WINDOW_FACTOR) : text
  return clip(redactStrings(window), max)
}

/**
 * 入参摘要：`k=v` 逗号拼接，命中敏感键名的整值替换。
 * 非对象入参（异常调用）整体序列化后截断。空对象/无入参返回 null（不存空串占位）。
 */
export function summarizeMcpArgs(args: unknown): string | null {
  if (args === null || args === undefined) return null
  if (typeof args !== 'object') return maskThenClip(args, MCP_CALL_ARGS_PREVIEW_CHARS)
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return null
  const parts = entries.map(([k, v]) =>
    SENSITIVE_LOG_KEY_RE.test(k)
      ? `${k}=${REDACTED_PLACEHOLDER}`
      : `${k}=${maskThenClip(typeof v === 'string' ? JSON.stringify(v) : v, MCP_CALL_VALUE_CHARS)}`
  )
  return clip(redactStrings(parts.join(', ').slice(0, MCP_CALL_ARGS_PREVIEW_CHARS * REDACTION_WINDOW_FACTOR)), MCP_CALL_ARGS_PREVIEW_CHARS)
}

/**
 * 结果摘要：MCP 的 result.content 是内容块数组，逐块取 text（图片等非文本块只标类型，
 * 不把 base64 塞进库），其它形状整体序列化。
 */
export function summarizeMcpResult(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') {
    const content = (raw as { content?: unknown }).content
    if (Array.isArray(content)) {
      const blocks = content.map((b) => {
        if (b && typeof b === 'object') {
          const item = b as { type?: unknown; text?: unknown }
          if (typeof item.text === 'string') return item.text
          return `[${String(item.type ?? 'block')}]`
        }
        return stringifyValue(b)
      })
      const merged = maskThenClip(blocks.join(' | '), MCP_CALL_RESULT_PREVIEW_CHARS)
      return merged === '' ? null : merged
    }
  }
  const text = maskThenClip(raw, MCP_CALL_RESULT_PREVIEW_CHARS)
  return text === '' ? null : text
}

/** 错误摘要（含 Error 与非 Error 抛出物） */
export function summarizeMcpError(e: unknown): string | null {
  if (e === null || e === undefined) return null
  const text = e instanceof Error ? `${e.name}: ${e.message}` : stringifyValue(e)
  const redacted = clip(redactStrings(text.slice(0, MCP_CALL_ERROR_CHARS * REDACTION_WINDOW_FACTOR)), MCP_CALL_ERROR_CHARS)
  return redacted === '' ? null : redacted
}
