// 提示词片段模板变量：用户自定义 {{变量}} 占位的提取与填充
// 与 main/assistant/prompt-template.ts 的系统固定变量（date/user_name 等）无关——
// 这里的变量名由片段作者定义，插入输入框前由 SnippetButton 弹框收集。
// 变量名允许英文/数字/下划线/中文（一-龥），其余形态（含空格、空占位）不视为变量。

const TEMPLATE_VAR_RE = /\{\{\s*([A-Za-z0-9_一-龥]+)\s*\}\}/g

/**
 * 提取片段内容中的变量名，去重且保持首次出现顺序。
 * 例：'把{{内容}}翻译成{{语言}}，再校对{{内容}}' → ['内容', '语言']
 */
export function extractTemplateVars(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of content.matchAll(TEMPLATE_VAR_RE)) {
    const name = m[1]!
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * 用用户填写的值替换全部占位：
 * - vals 中存在的 key（含空字符串）一律替换——空字符串代表用户显式留空；
 * - vals 中缺失的 key 保留原占位（防御：弹层理论上会收集全部变量）。
 */
export function applyTemplateVars(content: string, vals: Record<string, string>): string {
  return content.replace(TEMPLATE_VAR_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vals, name) ? vals[name]! : match
  )
}
