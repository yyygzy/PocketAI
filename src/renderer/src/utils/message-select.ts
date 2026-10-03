// 消息多选 Shift 范围连选纯函数
//
// 与文件管理器习惯一致：先普通点击设锚点，再 Shift+点击取锚点到目标之间
// （含两端、按列表顺序）。纯添加语义，区间外的既有选择保留。
// 无渲染/React 依赖，便于单测。

/**
 * 取有序 id 列表中 anchor 与 target 之间（含两端）的 id 区间。
 * - anchor 不在列表中（或为空）：退化为仅 [target]（target 也不在则空数组）
 * - anchor === target：[target]
 * - target 不在列表中：空数组
 */
export function rangeBetween(orderedIds: readonly string[], anchor: string | null, target: string): string[] {
  if (!anchor || anchor === target) {
    return orderedIds.includes(target) ? [target] : []
  }
  const ai = orderedIds.indexOf(anchor)
  const ti = orderedIds.indexOf(target)
  if (ai === -1) return orderedIds.includes(target) ? [target] : []
  if (ti === -1) return []
  const [from, to] = ai <= ti ? [ai, ti] : [ti, ai]
  return orderedIds.slice(from, to + 1)
}

/**
 * 把区间并入既有选择集（纯添加，不移除区间外已选项）。
 * 返回新 Set，不改入参。
 */
export function mergeRange(prev: ReadonlySet<string>, range: readonly string[]): Set<string> {
  const next = new Set(prev)
  for (const id of range) next.add(id)
  return next
}
