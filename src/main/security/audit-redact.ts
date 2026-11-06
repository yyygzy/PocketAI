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

/**
 * 只做文本级脱敏，**不封顶**。
 * 给诊断账本（agent_traces）用：那边要先脱敏、再按自己的 4000 字符截断。
 * 如果这里先按 2000 截断，既会丢掉诊断需要的中段，也可能在 2000 处把密钥切成半截。
 */
export function redactSecretsInText(text: string): string {
  let out = text
  for (const [re, replacement] of TEXT_RULES) out = out.replace(re, replacement)
  return out
}

/** 文本级脱敏 + 长度封顶（纯函数，便于单测） */
export function redactAuditText(text: string): string {
  const out = redactSecretsInText(text)
  if (out.length <= AUDIT_MAX_CHARS) return out
  return `${out.slice(0, AUDIT_MAX_CHARS)}…[已截断，原长 ${out.length} 字符]`
}

/**
 * 参数级脱敏，**不封顶**：优先按 JSON 结构做键名脱敏，再做文本级规则。
 * 解析失败（例如 shell 命令原样传递）时直接走文本级规则。
 * 给 trace 的 `tool_args` 用；截断由调用方按 trace 自己的 4000 口径做。
 */
export function redactArgsInText(argsJson: string | null | undefined): string {
  const raw = (argsJson ?? '').trim()
  if (!raw) return ''
  let text = raw
  try {
    // maxStringChars=Infinity：这里不封顶，长度上限交给调用方（审批 2000 / trace 4000）。
    // 若在此按 2000 截断，恰好跨 2000 的密钥会先被切成半截，后面的文本规则再也拼不回原形态。
    text = JSON.stringify(redactLogValue(JSON.parse(raw), undefined, 0, Infinity))
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
