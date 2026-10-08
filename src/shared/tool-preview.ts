// 工具审批弹窗的语义化预览字段构造（纯函数，不依赖 electron，供主进程调用与单测直接复用）
// 背景：MCP 工具审批展示原为 JSON.stringify 裸 JSON，这里按参数名启发式生成
// 「字段 key + 值」列表；key 供渲染端映射 i18n（agent.approval.field.<key>），
// 未识别的 key 回退显示原始参数名（与 reason code 同策略，宁可信息不丢）。
import type { ApprovalPreviewField } from './types'

const MAX_FIELDS = 6
const MAX_LONG_CHARS = 800 // mono 长文本截断
const MAX_SHORT_CHARS = 200 // 单行值截断

// 参数名（小写）包含匹配 → 规范化字段 key；按声明顺序优先命中
const PATH_KEYS = ['path', 'file', 'dir', 'folder']
const MONO_KEYS: Array<[string, string]> = [
  ['content', 'content'],
  ['command', 'command'],
  ['code', 'code'],
  ['script', 'code'],
  ['body', 'content']
]
const SHORT_KEYS: Array<[string, string]> = [
  ['query', 'query'],
  ['url', 'url'],
  ['expression', 'expression']
]

function truncate(v: string, max: number): string {
  return v.length > max ? `${v.slice(0, max)}…` : v
}

/**
 * 从已解析参数构造审批预览字段；空参数对象返回 null（调用方回退 JSON 展示）。
 * @param parsedArgs 工具参数对象（已 JSON.parse）
 * @param resolvePath 可选路径解析器（工作目录相对 → 绝对），解析失败回退原值
 */
export function buildToolPreviewFields(
  parsedArgs: Record<string, unknown>,
  resolvePath?: (p: string) => string
): ApprovalPreviewField[] | null {
  const entries = Object.entries(parsedArgs ?? {})
  if (entries.length === 0) return null
  const fields: ApprovalPreviewField[] = []
  for (const [rawKey, rawVal] of entries) {
    if (fields.length >= MAX_FIELDS) break
    const lk = rawKey.toLowerCase()
    if (typeof rawVal === 'string') {
      if (PATH_KEYS.some((k) => lk.includes(k))) {
        let v = rawVal
        if (resolvePath) {
          try {
            v = resolvePath(rawVal)
          } catch {
            /* 解析失败保留原值 */
          }
        }
        fields.push({ key: 'path', value: truncate(v, MAX_SHORT_CHARS) })
        continue
      }
      const mono = MONO_KEYS.find(([k]) => lk.includes(k))
      if (mono) {
        fields.push({ key: mono[1], value: truncate(rawVal, MAX_LONG_CHARS), mono: true })
        continue
      }
      const short = SHORT_KEYS.find(([k]) => lk.includes(k))
      if (short) {
        fields.push({ key: short[1], value: truncate(rawVal, MAX_SHORT_CHARS) })
        continue
      }
      fields.push({ key: rawKey, value: truncate(rawVal, MAX_SHORT_CHARS) })
    } else if (typeof rawVal === 'number' || typeof rawVal === 'boolean') {
      fields.push({ key: rawKey, value: String(rawVal) })
    } else if (rawVal != null) {
      // 对象/数组：JSON 摘要走 mono 块
      let json: string
      try {
        json = JSON.stringify(rawVal)
      } catch {
        json = String(rawVal)
      }
      fields.push({ key: rawKey, value: truncate(json, MAX_SHORT_CHARS), mono: true })
    }
  }
  return fields.length > 0 ? fields : null
}
