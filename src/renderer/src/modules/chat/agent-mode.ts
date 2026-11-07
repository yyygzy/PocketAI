// 会话级 Agent 模式开关的取值口径（P0-4b-1）
//
// 持久边界是会话行（`conversations.agent_mode`，迁移 v57）：切会话/重启都按各自的记录恢复。
// `local` 只剩两件事：尚未建会话的那一格（空串键），以及本次点击的乐观值（写库失败会回滚）。
// 记录里没有这一格时按关闭处理——与迁移前"没有条目即 false"逐字一致。
import type { ConversationRecord } from '../../../../shared/types'

/** 尚未建会话的暂存键：下一发消息才创建会话行，所以它只活在内存里 */
export const PENDING_AGENT_MODE_KEY = ''

type AgentModeRecord = Pick<ConversationRecord, 'id' | 'agentMode'>

export function resolveAgentMode(
  convId: string | null,
  records: ReadonlyArray<AgentModeRecord>,
  local: Record<string, boolean>
): boolean {
  if (!convId) return local[PENDING_AGENT_MODE_KEY] === true
  if (Object.prototype.hasOwnProperty.call(local, convId)) return local[convId] === true
  return records.find((r) => r.id === convId)?.agentMode === true
}
