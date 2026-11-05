// 审批审计参数脱敏（P0-2c-1）
//
// 与日志脱敏的区别：日志只认键名；审批要落库保存 args 摘要，shell 命令 / URL query
// 里的 Authorization、Bearer、api_key= 等不在键上，必须再做一层文本级替换。
// 这里不追求“智能识别所有密钥”，只覆盖已知高频形态，并在 2000 字符处封顶。

import { MAX_LOG_STRING_CHARS, redactLogValue } from './log-redact'

const AUDIT_MAX_CHARS = MAX_LOG_STRING_CHARS

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
  [/([?&](?:api[_-]?key|apikey|access[_-]?token|access[_-]?key|token|secret)=)([^&\s#"']+)/gi, '$1[redacted]']
]

/** 文本级脱敏 + 长度封顶（纯函数，便于单测） */
export function redactAuditText(text: string): string {
  let out = text
  for (const [re, replacement] of TEXT_RULES) out = out.replace(re, replacement)
  if (out.length <= AUDIT_MAX_CHARS) return out
  return `${out.slice(0, AUDIT_MAX_CHARS)}…[已截断，原长 ${out.length} 字符]`
}

/**
 * 审批参数摘要：优先按 JSON 结构做键名脱敏，再做文本级规则，最后 2000 字符封顶。
 * 解析失败（例如 shell 命令原样传递）时直接走文本级规则。
 */
export function redactArgsForAudit(argsJson: string | null | undefined): string {
  const raw = (argsJson ?? '').trim()
  if (!raw) return ''
  let text = raw
  try {
    text = JSON.stringify(redactLogValue(JSON.parse(raw)))
  } catch {
    text = raw
  }
  return redactAuditText(text)
}
