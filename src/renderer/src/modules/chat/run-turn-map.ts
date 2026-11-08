// P2（V4-Iter-459）：把只读 run 索引映射到对话轮次。
//
// 为什么需要这一层：`messages` 表没有 requestId 列，run 与轮次之间唯一的直接线索是
// `agent_traces.message_id`（回放引用列，只覆盖"返回值被截断"的那几步，旧行常为 NULL）。
// 所以这里按文档定两档：**先按 message_id 命中，缺失时用 created_at 区间兜底**。
// 纯函数、不读库，供 ChatModule 一次算好、ChatView 按轮次查表。
import type { AgentRunIndexEntry, MessageRecord } from '../../../../shared/types'

/** 一个对话轮次的边界与它包含的消息 id（key = 该轮首条消息 id，与 ChatView 的虚拟项 key 同源） */
export interface TurnBoundary {
  key: string
  messageIds: string[]
  /** 该轮开始时间（首条消息 createdAt） */
  startedAt: number
  /** 下一轮开始时间（独占）；最后一轮为 Infinity */
  endedAt: number
}

/**
 * 按 ChatView 的分组口径切轮次：每条 user 消息开一轮，其后的 assistant/tool 都归这一轮。
 * 首条不是 user 时也单开一轮（与 ChatView 的 `items[0]` 一致）。
 */
export function buildTurnBoundaries(messages: MessageRecord[]): TurnBoundary[] {
  const out: TurnBoundary[] = []
  for (const m of messages) {
    if (m.role === 'user' || out.length === 0) {
      out.push({ key: m.id, messageIds: [m.id], startedAt: m.createdAt, endedAt: Infinity })
    } else {
      out[out.length - 1]!.messageIds.push(m.id)
    }
  }
  for (let i = 0; i < out.length - 1; i += 1) out[i]!.endedAt = out[i + 1]!.startedAt
  return out
}

/**
 * run → 轮次（反向：轮次 key → 这一轮的 run 摘要）。
 *
 * - 先按 `messageIds` 命中：一个 run 的任一条 message_id 落在某一轮里，就归那一轮；
 * - 没有再按区间：`startedAt <= run.startedAt < endedAt` 的那一轮（时钟对齐、旧行为 NULL 时靠它）；
 * - 同一轮有多条 run（重跑留下旧 trace）时取 `endedAt` 最新的那条：摘要讲「这一轮最后跑成什么样」，
 *   而不是把两次运行的数字相加（相加既不是任一次的真实成本，也和「本次运行统计」对不上）。
 */
export function mapRunsToTurns(
  runs: AgentRunIndexEntry[],
  turns: TurnBoundary[]
): Map<string, AgentRunIndexEntry> {
  const byMessageId = new Map<string, TurnBoundary>()
  for (const turn of turns) {
    for (const id of turn.messageIds) byMessageId.set(id, turn)
  }

  const out = new Map<string, AgentRunIndexEntry>()
  for (const run of runs) {
    let target: TurnBoundary | undefined
    for (const id of run.messageIds) {
      const hit = byMessageId.get(id)
      if (hit) {
        target = hit
        break
      }
    }
    if (!target) {
      target = turns.find((t) => run.startedAt >= t.startedAt && run.startedAt < t.endedAt)
    }
    if (!target) continue
    const prev = out.get(target.key)
    if (!prev || run.endedAt >= prev.endedAt) out.set(target.key, run)
  }
  return out
}
