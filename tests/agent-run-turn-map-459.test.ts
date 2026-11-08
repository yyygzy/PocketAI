// P2（V4-Iter-459）：run 索引 → 对话轮次的纯函数映射用例。
//
// `messages` 没有 requestId 列，所以映射只能靠两条线索；这里把两条都钉住：
// · 优先 `agent_traces.message_id`（回放引用列，旧行常为 NULL）；
// · 缺失时按 `created_at` 区间兜底；
// · 同一轮重跑留下多条 run 时取 `endedAt` 最新的那条（数字不能相加）。
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import type { AgentRunIndexEntry, MessageRecord } from '../src/shared/types'
import { buildTurnBoundaries, mapRunsToTurns } from '../src/renderer/src/modules/chat/run-turn-map'

function msg(id: string, role: MessageRecord['role'], createdAt: number): MessageRecord {
  return {
    id,
    conversationId: 'conv-459',
    role,
    content: id,
    provider: null,
    model: null,
    status: 'done',
    parentId: null,
    createdAt
  }
}

function run(requestId: string, startedAt: number, endedAt: number, messageIds: string[] = []): AgentRunIndexEntry {
  return {
    requestId,
    conversationId: 'conv-459',
    startedAt,
    endedAt,
    stepCount: 3,
    totalDurationMs: 400,
    totalTokens: 100,
    errorSteps: 0,
    messageIds
  }
}

/** 50 轮：每轮 user + assistant（assistant 只在 message_id 缺失时才靠区间） */
function longConversation(turns: number): { messages: MessageRecord[]; userIds: string[]; assistantIds: string[] } {
  const messages: MessageRecord[] = []
  const userIds: string[] = []
  const assistantIds: string[] = []
  for (let i = 1; i <= turns; i += 1) {
    const uid = `u-${i}`
    const aid = `a-${i}`
    userIds.push(uid)
    assistantIds.push(aid)
    messages.push(msg(uid, 'user', i * 10_000))
    messages.push(msg(aid, 'assistant', i * 10_000 + 1))
  }
  return { messages, userIds, assistantIds }
}

describe('buildTurnBoundaries', () => {
  it('每条 user 开一轮，tool/assistant 留在同一轮；区间到下一轮开始为止', () => {
    const messages = [
      msg('u1', 'user', 1000),
      msg('a1', 'assistant', 1100),
      msg('t1', 'tool', 1200),
      msg('u2', 'user', 2000),
      msg('a2', 'assistant', 2100)
    ]
    const turns = buildTurnBoundaries(messages)
    expect(turns.map((t) => t.key)).toEqual(['u1', 'u2'])
    expect(turns[0]!.messageIds).toEqual(['u1', 'a1', 't1'])
    expect(turns[0]!.endedAt).toBe(2000)
    expect(turns[1]!.endedAt).toBe(Infinity)
  })
})

describe('mapRunsToTurns', () => {
  it('50 轮长会话：50 个 run 全部落到对应轮次（message_id 缺失时按区间）', () => {
    const { messages } = longConversation(50)
    const turns = buildTurnBoundaries(messages)
    const runs = Array.from({ length: 50 }, (_, i) =>
      run(`r-${i + 1}`, (i + 1) * 10_000 + 2, (i + 1) * 10_000 + 500)
    )
    const mapped = mapRunsToTurns(runs, turns)
    expect(mapped.size).toBe(50)
    for (let i = 0; i < 50; i += 1) {
      expect(mapped.get(`u-${i + 1}`)?.requestId).toBe(`r-${i + 1}`)
    }
  })

  it('message_id 优先于时间区间：run 有时钟错位也不会挂错轮', () => {
    const messages = [
      msg('u1', 'user', 1000),
      msg('a1', 'assistant', 1100),
      msg('u2', 'user', 2000),
      msg('a2', 'assistant', 2100),
      msg('u3', 'user', 3000),
      msg('a3', 'assistant', 3100)
    ]
    const turns = buildTurnBoundaries(messages)
    // startedAt 落在第 2 轮区间，但 message_id 指向第 3 轮的 assistant
    const mapped = mapRunsToTurns([run('r-x', 2050, 2200, ['a3'])], turns)
    expect(mapped.get('u3')?.requestId).toBe('r-x')
    expect(mapped.has('u2')).toBe(false)
  })

  it('同一轮多条 run（重跑残留）：取 endedAt 最新的那条，不做数字相加', () => {
    const messages = [msg('u1', 'user', 1000), msg('a1', 'assistant', 1100)]
    const turns = buildTurnBoundaries(messages)
    const mapped = mapRunsToTurns(
      [run('r-old', 1200, 1500), run('r-new', 1600, 1900)],
      turns
    )
    expect(mapped.get('u1')?.requestId).toBe('r-new')
  })

  it('落在第一条 user 之前 / 没有任何轮次的 run 不硬塞', () => {
    const messages = [msg('u1', 'user', 1000), msg('a1', 'assistant', 1100)]
    const turns = buildTurnBoundaries(messages)
    expect(mapRunsToTurns([run('r-before', 10, 20)], turns).size).toBe(0)
    expect(mapRunsToTurns([run('r-empty', 1200, 1300)], []).size).toBe(0)
  })
})
