// MCP 试运行的「示例参数」生成（只做填表辅助，不校验、不展示完整 schema）
//
// 只认三个来源：default / examples[0] / enum[0]。没有就跳过——宁可留空让用户自己填，
// 也不要编一个看起来像真的值。嵌套对象与 required 不在本批范围内。
export function buildExampleArgs(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return {}
  const props = (parameters as { properties?: unknown }).properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}

  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const schema = raw as { default?: unknown; examples?: unknown; enum?: unknown }
    if (schema.default !== undefined) {
      out[key] = schema.default
      continue
    }
    if (Array.isArray(schema.examples) && schema.examples.length > 0) {
      out[key] = schema.examples[0]
      continue
    }
    if (Array.isArray(schema.enum) && schema.enum.length > 0) out[key] = schema.enum[0]
  }
  return out
}
