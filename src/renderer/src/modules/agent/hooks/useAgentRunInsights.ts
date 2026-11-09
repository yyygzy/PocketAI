import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRunIndexEntry, AgentSessionStats, MessageRecord } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { errText } from '../../../utils/error'
import { hasIpcFailed, ipcFailText, reportIpcError } from '../../../utils/ipc'
import { buildTurnBoundaries, mapRunsToTurns } from '../../chat/run-turn-map'

export interface UseAgentRunInsightsOptions {
  conversationId: string | null
  /** 仅工具有效会话启用（普通会话打开时一次都不发 `agent:list-runs`） */
  enabled: boolean
  /** 当前会话消息（用于把 run 映射到轮次；不触发重新读库） */
  messages: MessageRecord[]
  /** 递增即重读：`onStreamsSettled` 后主动刷新，否则跑完一轮数字还是上一轮的 */
  refreshToken?: number
}

export interface AgentRunInsights {
  runs: AgentRunIndexEntry[]
  /** 轮次 key（该轮首条消息 id）→ 本轮 run 摘要 */
  runsByTurn: Map<string, AgentRunIndexEntry>
  /** 读取失败的原因（读不到 ≠ 没有运行） */
  unread: string | null
  /**
   * P4 批次 0：会话级累计（总 token / 耗时 / 步数）。
   * 直接读主进程 `agent:get-session-stats`——与 Agent 壳同一份聚合口径，不在渲染层拿
   * `listAgentRuns`（只取最近 50 轮）自己求和，避免长会话把"总步数"算少。
   */
  sessionStats: AgentSessionStats | null
  sessionUnread: string | null
  /** 那一发读不到时的重试 */
  retrySessionStats: () => void
}

/**
 * P2（V4-Iter-459）：对话页的 run 索引读取 + 轮次映射。
 *
 * 两件事分开：**读库**只在会话/开关/刷新令牌变化时发生；**映射**是纯函数，随消息与 runs 重算。
 * 这样流式期间消息每帧变化不会反复打 `agent:list-runs`，而 `onStreamsSettled` 主动刷新一次就能
 * 把刚跑完那轮的数字挂上去（`useStreamSession` 的 settle 早于 200ms 后的消息重载，映射靠区间兜底）。
 */
export function useAgentRunInsights({
  conversationId,
  enabled,
  messages,
  refreshToken = 0
}: UseAgentRunInsightsOptions): AgentRunInsights {
  const { t } = useI18n()
  const [runs, setRuns] = useState<AgentRunIndexEntry[]>([])
  const [unread, setUnread] = useState<string | null>(null)
  const [sessionStats, setSessionStats] = useState<AgentSessionStats | null>(null)
  const [sessionUnread, setSessionUnread] = useState<string | null>(null)
  const [sessionRetry, setSessionRetry] = useState(0)
  // 迟到响应写进共享槽（§309／§311 同族）：切会话后旧读落回时只认还成立的那一代
  const liveConvRef = useRef<string | null>(conversationId)
  liveConvRef.current = conversationId

  useEffect(() => {
    if (!conversationId || !enabled) {
      setRuns([])
      setUnread(null)
      return
    }
    let alive = true
    const target = conversationId
    window.pocketai
      .listAgentRuns(target)
      .then((list) => {
        if (!alive || liveConvRef.current !== target) return
        if (hasIpcFailed(list)) {
          setUnread(ipcFailText(list, t('common.unknownError')))
          setRuns([])
          return
        }
        setUnread(null)
        setRuns(Array.isArray(list) ? list : [])
      })
      .catch((e) => {
        reportIpcError('agent.listAgentRuns')(e)
        if (!alive || liveConvRef.current !== target) return
        setUnread(errText(e, t('common.unknownError')))
        setRuns([])
      })
    return () => {
      alive = false
    }
  }, [conversationId, enabled, refreshToken, t])

  /**
   * 会话累计：与 run 索引同一批触发条件（会话/开关/落定刷新/手动重试）。
   * 读不到时保留上一次的数字？不——与 Agent 壳一致，失败就把数字让位给一句"读不到"，
   * 否则屏上会用旧数替这一次失败说话。
   */
  useEffect(() => {
    if (!conversationId || !enabled) {
      setSessionStats(null)
      setSessionUnread(null)
      return
    }
    let alive = true
    const target = conversationId
    window.pocketai
      .getSessionStats(target)
      .then((stats) => {
        if (!alive || liveConvRef.current !== target) return
        if (hasIpcFailed(stats)) {
          setSessionUnread(ipcFailText(stats, t('common.unknownError')))
          setSessionStats(null)
          return
        }
        setSessionUnread(null)
        setSessionStats(stats ?? null)
      })
      .catch((e) => {
        reportIpcError('agent.getSessionStats')(e)
        if (!alive || liveConvRef.current !== target) return
        setSessionUnread(errText(e, t('common.unknownError')))
        setSessionStats(null)
      })
    return () => {
      alive = false
    }
  }, [conversationId, enabled, refreshToken, sessionRetry, t])

  const retrySessionStats = useMemo(() => () => setSessionRetry((n) => n + 1), [])

  const runsByTurn = useMemo(
    () => mapRunsToTurns(runs, buildTurnBoundaries(messages)),
    [runs, messages]
  )

  return { runs, runsByTurn, unread, sessionStats, sessionUnread, retrySessionStats }
}
