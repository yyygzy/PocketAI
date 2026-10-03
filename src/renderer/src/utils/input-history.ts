// 输入历史召回（终端式 ↑）：localStorage 环形缓冲，全局跨会话共享。
// 纯函数与存储读写分离，便于单测（测试注入内存存储）。
export const INPUT_HISTORY_KEY = 'pocketai:input-history'
export const INPUT_HISTORY_MAX = 50

/** 规范化并追加一条历史：空串/纯空白不收；与最新一条相同则跳过（终端惯例） */
export function appendHistory(list: string[], entry: string, max = INPUT_HISTORY_MAX): string[] {
  const v = entry.trim()
  if (!v) return list
  if (list.length > 0 && list[list.length - 1] === v) return list
  const next = [...list, v]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 从存储读历史；坏 JSON/非数组/非字符串项容错为空数组 */
export function loadHistory(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const raw = storage.getItem(INPUT_HISTORY_KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
  } catch {
    return []
  }
}

/** 追加并持久化；返回最新列表 */
export function pushHistory(entry: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string[] {
  const next = appendHistory(loadHistory(storage), entry)
  try {
    storage.setItem(INPUT_HISTORY_KEY, JSON.stringify(next))
  } catch { /* 存储满/不可用不阻断发送 */ }
  return next
}
