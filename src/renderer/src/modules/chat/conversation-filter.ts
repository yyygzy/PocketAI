// P1（V4-Iter-457）：会话列表的展示口径纯函数——「允许调用工具」是能力徽标，不是会话类型。
// 唯一判定源是 `conversations.agentMode`（库列 agent_mode）；绝不再看 modelLabel 前缀。
// 抽成纯函数是为了让「筛选 / 全选 / 归档跟随」能直接断言，而不依赖组件快照。

import type { ConversationRecord } from '../../../../shared/types'

export type ToolsFilter = 'all' | 'tools' | 'plain'

/** 单个会话是否命中能力筛选；`agentMode` 缺省（旧记录）按普通对话处理 */
export function matchesToolsFilter(
  conv: Pick<ConversationRecord, 'agentMode'>,
  filter: ToolsFilter
): boolean {
  if (filter === 'all') return true
  const tools = conv.agentMode === true
  return filter === 'tools' ? tools : !tools
}

/**
 * 列表可见集：标题搜索与能力筛选是 **AND**。
 * 筛选态只看这两个条件，不改变列表数据本身。
 */
export function filterVisibleConversations(
  conversations: ConversationRecord[],
  options: { titleQuery?: string; toolsFilter?: ToolsFilter } = {}
): ConversationRecord[] {
  const query = (options.titleQuery ?? '').trim().toLowerCase()
  const toolsFilter = options.toolsFilter ?? 'all'
  if (!query && toolsFilter === 'all') return conversations
  return conversations.filter(
    (c) => matchesToolsFilter(c, toolsFilter) && (!query || c.title.toLowerCase().includes(query))
  )
}

/** 全选是否成立：基于**筛选后**的可见集，空集不算选中 */
export function isAllVisibleSelected(
  visible: ConversationRecord[],
  selectedIds: readonly string[]
): boolean {
  if (visible.length === 0) return false
  const selected = new Set(selectedIds)
  return visible.every((c) => selected.has(c.id))
}

/** 全选要写入的 id 集合：只含筛选后的可见集 */
export function selectAllVisibleIds(visible: ConversationRecord[]): string[] {
  return visible.map((c) => c.id)
}
