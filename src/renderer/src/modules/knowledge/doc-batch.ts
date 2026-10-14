// 文档批量操作的纯决策层：哪些算失败、怎么选、选中项如何随列表刷新出清。
//
// 抽出来的原因与 `ZeroToolCallNotice` / `sim-stats` 同一套：`KbDetail` 挂不上测试
// （要 confirm / toast / 十几条 IPC），但下面这几条是可以逐条钉住的——
// 尤其是「文档被删掉之后，选择里不许留幽灵计数」。
import type { KbDocument } from '../../../../shared/types'

/** 入库失败的文档 id（重试全部失败的作用范围；只认 status==='error'，pending/indexing 不算） */
export function errorDocIds(docs: KbDocument[]): string[] {
  return docs.filter((d) => d.status === 'error').map((d) => d.id)
}

/** 勾选 / 取消勾选一个 id（返回新数组，不改调用方的 state） */
export function toggleSelected(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]
}

/**
 * 列表刷新后把已不存在的选中项丢掉。
 * 批量删除 / 别的窗口改动 / 去重工具收掉之后，选择里若留着幽灵 id，
 * 界面会继续显示「已选 N 篇」并把动作作用到不存在的文档上。
 */
export function cullStale(selected: string[], docs: KbDocument[]): string[] {
  const alive = new Set(docs.map((d) => d.id))
  return selected.filter((id) => alive.has(id))
}

/** 全选 / 全选失败项：顺序一律跟列表一致，保证「按列表顺序处理」不变成随机 */
export function selectByMode(docs: KbDocument[], mode: 'all' | 'errors'): string[] {
  return mode === 'all' ? docs.map((d) => d.id) : errorDocIds(docs)
}
