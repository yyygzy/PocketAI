// 审批审计参数脱敏（P0-2c-1）
//
// 与日志脱敏的区别：日志的结构体参数只认键名；审批要落库保存 args 摘要，shell 命令 / URL query
// 里的 Authorization、Bearer、api_key= 等不在键上，必须再做一层文本级替换。
// 这里不追求“智能识别所有密钥”，只覆盖已知高频形态，并在 2000 字符处封顶。

import type { AgentTraceRecord } from '../../shared/types'
import {
  MAX_LOG_STRING_CHARS,
  REDACTED_PLACEHOLDER,
  SENSITIVE_LOG_KEY_RE
} from './log-redact'

const AUDIT_MAX_CHARS = MAX_LOG_STRING_CHARS

/**
 * 裸 token 的规则与边界：
 *
 * · 起始边界 `(?<![A-Za-z0-9_-])`：前面必须不是 key 字符。
 *   只用 `sk-[A-Za-z0-9_-]{8,}` 会把正文里的 `risk-management` / `task-first` / `disk-usage`
 *   一起吃掉（它们中间都含 `sk-`）；加了这个边界后，这些词天然不命中。
 * · `sk-` 后要求 ≥8 个 key 字符：真实 key 远长于 8，而 `sk-learn`（后缀 5）这类短词也不会被误伤。
 * · 不要求同时含字母和数字：`sk-live-ABCDEFGH` 这类全字母值同样是密钥形态，
 *   强行要求混合字符会漏掉它们。
 * · 每条都是「固定长度 lookbehind + 单层字符类量词」，没有嵌套量词，不存在回溯放大。
 */
const BARE_TOKEN_RULES: Array<[RegExp, string]> = [
  // OpenAI 风格：sk- 后至少 8 个 key 字符（含 -/_）
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}/g, REDACTED_PLACEHOLDER],
  // Google API key：AIza + 20 位以上
  [/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{20,}/g, REDACTED_PLACEHOLDER],
  // AWS access key id：AKIA + 12 位以上大写字母/数字
  [/(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{12,}/g, REDACTED_PLACEHOLDER],
  // GitHub classic PAT：ghp_ + 16 位以上
  [/(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9]{16,}/g, REDACTED_PLACEHOLDER],
  // Slack token：xoxb-/xoxa-/xoxp-/xoxr-/xoxs-
  [/(?<![A-Za-z0-9_-])xox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED_PLACEHOLDER]
]

const TEXT_RULES: Array<[RegExp, string]> = [
  // Authorization: xxx / Authorization=xxx（含引号形式；`Bearer xxx` 整段算一个值，不留裸 token）
  [/(authorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;"'}]+|[^\s,;"'}]+)/gi, '$1[redacted]'],
  // 裸 Bearer token（不只出现在 Authorization 头里）
  [/(bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[redacted]'],
  // api_key=xxx / token=xxx / secret=xxx / password=xxx（含引号形式）
  [
    /((?:api[_-]?key|apikey|access[_-]?token|access[_-]?key|token|secret|password|passwd|credential|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}"']+)/gi,
    '$1[redacted]'
  ],
  // URL query：?token=xxx / &api_key=xxx
  [/([?&](?:api[_-]?key|apikey|access[_-]?token|access[_-]?key|token|secret)=)([^&\s#"']+)/gi, '$1[redacted]'],
  // provider 回显：`Incorrect API key provided: sk-...`（token 不以 sk- 开头也照样拿掉）
  // 值里排除 [ ] { } 等定界符：否则第二遍会把 `[redacted]` 的 `[redacted` 再包一层，破坏幂等。
  [/(incorrect\s+api\s+key\s+provided\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;"')\[\]}]+)/gi, '$1[redacted]'],
  ...BARE_TOKEN_RULES
]

/**
 * JSON 文本里的敏感键值（`"api_key":"xxx"`）：文本规则 `api_key\s*[:=]` 命中不到键名后的引号，
 * 这里就地替换值、不动格式。键名判定复用 log-redact 的 `SENSITIVE_LOG_KEY_RE`（子串、大小写不敏感），
 * 因此 `clientSecret` / `X-Api-Key` 这类复合键与结构化脱敏同口径。
 *
 * 不用正则：`"([^"\\]*(?:\\.[^"\\]*)*)"` 这类经典 JSON 字符串正则在 `\"\"\"…` 这种对抗性输入上
 * 会从每个引号重扫尾部（O(n²)）。这里用手写扫描器，每个字符只前进一次，最坏 O(n)，没有回溯。
 */
function redactJsonKeyValuesInPlace(text: string): string {
  const firstQuote = text.indexOf('"')
  // 快速路径：没有引号就不可能是 JSON 键值，原样返回（绝大多数 trace 文本走这里）
  if (firstQuote < 0) return text
  let out = text.slice(0, firstQuote)
  let i = firstQuote
  const n = text.length
  while (i < n) {
    if (text[i] !== '"') {
      // 普通文本一次拷贝到下一个引号，避免逐字符拼接
      const next = text.indexOf('"', i)
      if (next < 0) {
        out += text.slice(i)
        break
      }
      out += text.slice(i, next)
      i = next
      continue
    }
    // 读一个 JSON 字符串（引号内允许 \x 转义）；找不到闭合引号就原样收尾
    const keyStart = i + 1
    let j = keyStart
    while (j < n) {
      const c = text[j]
      if (c === '\\') {
        j += 2
        continue
      }
      if (c === '"') break
      j++
    }
    if (j >= n) {
      out += text.slice(i)
      break
    }
    const rawKey = text.slice(keyStart, j)
    // 必须紧跟（可带空白）冒号，才是对象键
    let k = j + 1
    while (k < n && /\s/.test(text[k]!)) k++
    if (text[k] !== ':') {
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    k++
    while (k < n && /\s/.test(text[k]!)) k++
    if (text[k] !== '"') {
      out += text.slice(i, k)
      i = k
      continue
    }
    // 值字符串：找到闭合引号（同样尊重转义）
    let v = k + 1
    while (v < n) {
      const c = text[v]
      if (c === '\\') {
        v += 2
        continue
      }
      if (c === '"') break
      v++
    }
    if (v >= n) {
      out += text.slice(i)
      break
    }
    let key = rawKey
    if (rawKey.includes('\\')) {
      try {
        key = JSON.parse(`"${rawKey}"`) as string
      } catch {
        // 转义不合法：按原样判断，宁可多脱一处也不漏
      }
    }
    out += SENSITIVE_LOG_KEY_RE.test(key) ? `${text.slice(i, k)}"[redacted]"` : text.slice(i, v + 1)
    i = v + 1
  }
  return out
}

/**
 * 只做文本级脱敏，**不封顶**。
 * 给诊断账本（agent_traces）用：那边要先脱敏、再按自己的 4000 字符截断。
 * 如果这里先按 2000 截断，既会丢掉诊断需要的中段，也可能在 2000 处把密钥切成半截。
 *
 * 幂等：替换产物是 `[redacted]`（键值形态只折值、保留键名），再过一遍不会二次变形。
 */
export function redactSecretsInText(text: string): string {
  let out = text
  for (const [re, replacement] of TEXT_RULES) out = out.replace(re, replacement)
  return redactJsonKeyValuesInPlace(out)
}

/**
 * JSON 递归深度上限：与 log-redact 的 MAX_DEPTH 保持一致（4）。
 * 不放大这个值，是为了不让既有 `tool_args` 的嵌套形状语义发生额外变化；
 * 超过深度的子树整段折成 `[depth-limit]`，也不会泄露。
 */
const MAX_JSON_DEPTH = 4

/**
 * 解析后的 JSON 逐值脱敏：键名命中敏感词整值替换，字符串值本身再跑一遍文本规则。
 * 只按键名脱敏会漏掉 `{"error":{"message":"Incorrect API key provided: sk-..."}}` 这种值内嵌。
 */
function redactJsonValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecretsInText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_JSON_DEPTH) return '[depth-limit]'
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_LOG_KEY_RE.test(k) ? REDACTED_PLACEHOLDER : redactJsonValue(v, depth + 1)
  }
  return out
}

/** 文本级脱敏 + 长度封顶（纯函数，便于单测） */
export function redactAuditText(text: string): string {
  const out = redactSecretsInText(text)
  if (out.length <= AUDIT_MAX_CHARS) return out
  return `${out.slice(0, AUDIT_MAX_CHARS)}…[已截断，原长 ${out.length} 字符]`
}

/**
 * 参数级脱敏，**不封顶**：优先按 JSON 结构做键名 + 值脱敏，再做文本级规则。
 * 解析失败（例如 shell 命令原样传递）时直接走文本级规则。
 * 给 trace 的 `tool_args` 用；截断由调用方按 trace 自己的 4000 口径做。
 */
export function redactArgsInText(argsJson: string | null | undefined): string {
  const raw = (argsJson ?? '').trim()
  if (!raw) return ''
  let text = raw
  try {
    // 递归到值：按键名脱敏之后再对每个字符串值跑文本规则。
    // 这里不封顶，长度上限交给调用方（审批 2000 / trace 4000）。
    text = JSON.stringify(redactJsonValue(JSON.parse(raw)))
  } catch {
    text = raw
  }
  return redactSecretsInText(text)
}

/**
 * 审批参数摘要：参数级脱敏 + 2000 字符封顶。
 */
export function redactArgsForAudit(argsJson: string | null | undefined): string {
  const out = redactArgsInText(argsJson)
  if (out.length <= AUDIT_MAX_CHARS) return out
  return `${out.slice(0, AUDIT_MAX_CHARS)}…[已截断，原长 ${out.length} 字符]`
}

/**
 * 读时兜底（历史行无法回写）：trace 离开主进程前，对三列自由文本再过一遍文本规则。
 *
 * 这里**只做文本级替换**，不 JSON.parse/stringify、不重新截断——
 * 库里已存的形状（包括 4000 截断提示）必须原样保留，否则每读一次就变一次形。
 * 幂等：已脱敏的值再过一遍结果不变（`[redacted]` 不会被二次处理）。
 */
export function redactTraceFieldsForRead(rec: AgentTraceRecord): AgentTraceRecord {
  return {
    ...rec,
    error: rec.error ? redactSecretsInText(rec.error) : rec.error,
    toolArgs: rec.toolArgs ? redactSecretsInText(rec.toolArgs) : rec.toolArgs,
    toolResult: rec.toolResult ? redactSecretsInText(rec.toolResult) : rec.toolResult
  }
}
