// 轮次检查器（P2 / V4-Iter-459）：摘要展开后才读库，步骤流 / 每步 token / 变更清单 / replay / 子会话
import React, { useEffect, useState } from 'react'
import type { AgentRunIndexEntry, AgentTraceRecord } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'
import { AgentTraceList } from './AgentTraceList'

interface AgentRunInspectorProps {
  run: AgentRunIndexEntry
  /** 子会话入口：不传则只展示子会话数量，不渲染按钮 */
  onOpenSubSession?: (conversationId: string) => void
}

/**
 * 按需展开的检查器本体。
 * 挂载即读 `getRunTraces(run.requestId)`（摘要折叠时本组件不渲染，所以不会有人提前读库）；
 * 变更清单由 `AgentTraceList` 统一从 `agent_traces.change_set` 经 `parseWorkspaceChangeSet` 解析。
 */
export const AgentRunInspector: React.FC<AgentRunInspectorProps> = ({ run, onOpenSubSession }) => {
  const { t } = useI18n()
  const [traces, setTraces] = useState<AgentTraceRecord[] | null>(null)
  const [unread, setUnread] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setUnread(null)
    void window.pocketai
      .getRunTraces(run.requestId)
      .then((rows) => {
        if (!alive) return
        if (hasIpcFailed(rows)) {
          setUnread(ipcFailText(rows, t('agent.unknownError')))
          setTraces([])
        } else {
          setTraces(rows)
        }
        setLoading(false)
      })
      .catch((e: unknown) => {
        logIpcError('agent.getRunTraces', e)
        if (!alive) return
        setUnread(errText(e, t('agent.unknownError')))
        setTraces([])
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [run.requestId, reload, t])

  const childIds = run.childConversationIds ?? []

  return (
    <div data-testid="agent-run-inspector" className="mt-1.5 space-y-1.5 rounded border border-[var(--color-border)] p-2">
      {loading && <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>}
      {/* 读不到与「确实没有明细」分开说：三态口径同 Agent 调试台（§257） */}
      {!loading && unread && (
        <div
          data-testid="agent-run-traces-unread"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-danger)]"
        >
          <span title={unread}>{t('common.loadFailed', { msg: unread })}</span>
          <button
            onClick={() => setReload((v) => v + 1)}
            className="px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
          >
            {t('agent.retryRead')}
          </button>
        </div>
      )}
      {!loading && !unread && traces && traces.length === 0 && (
        <div className="text-xs text-[var(--color-text-muted)]">{t('agent.traceEmpty')}</div>
      )}
      {!loading && !unread && traces && traces.length > 0 && <AgentTraceList traces={traces} />}

      {childIds.length > 0 && (
        <div data-testid="agent-run-subsessions" className="flex flex-wrap items-center gap-x-1.5">
          <span className="text-xs text-[var(--color-text-muted)]">{t('agent.subSessions', { n: childIds.length })}</span>
          {onOpenSubSession &&
            childIds.map((id) => (
              <button
                key={id}
                onClick={() => onOpenSubSession(id)}
                data-testid={`agent-run-open-sub-${id}`}
                title={id}
                className="px-1.5 py-0.5 rounded border border-[var(--color-accent)] text-xs text-[var(--color-accent)] hover:opacity-80 transition-opacity"
              >
                {t('agent.openSubSession')} · {id.slice(0, 8)}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
