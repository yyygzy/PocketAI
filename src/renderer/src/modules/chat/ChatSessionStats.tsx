// 对话页的会话级统计入口（P4 批次 0）。
//
// 位置：顶部模型栏右侧一颗紧凑徽标（`📊 次数`），点开是一块下拉详情——总次数 / 总步数 /
// 总耗时 / 总 token。数据来自 `useAgentRunInsights` 里那发 `agent:get-session-stats`，
// 读的是**同一份主进程聚合**，不在这里重算：
// `listAgentRuns` 只取最近 50 轮，拿它求和会把长会话的总步数算少。
//
// 读不到时不让旧数字继续站台：徽标转警示色，展开后是一句点名「会话累计统计读不到」＋重试。
import React, { useEffect, useRef, useState } from 'react'
import type { AgentSessionStats } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { formatRunDuration } from '../../components/agent/agent-shared'

interface Props {
  stats: AgentSessionStats | null
  /** 读不到的原因（已由 hook 归一成一句可显示文案）；非空时不摆数字 */
  unread: string | null
  onRetry: () => void
}

export const ChatSessionStats: React.FC<Props> = ({ stats, unread, onRetry }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点外部 / Esc 收起：与 FloatingPanel 同一套手感，但这枚挂在顶栏、要向下展开，
  // 不复用那份「贴着锚点向上长」的原语
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // 没有运行、且这一发也没失败：没有可说的会话统计，入口整块不出现
  if (!stats && !unread) return null

  const detail = stats
    ? t('agent.sessionStatsWithSteps', {
        runs: stats.runCount,
        steps: stats.totalSteps ?? 0,
        duration: formatRunDuration(stats.totalDurationMs),
        tokens: stats.totalTokens.toLocaleString('en-US')
      })
    : t('common.loadFailedNamed', {
        what: t('agent.sessionStatsBlock'),
        msg: unread ?? t('common.unknownError')
      })

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        data-testid="chat-session-stats"
        onClick={() => setOpen((v) => !v)}
        title={detail}
        aria-label={t('agent.sessionStatsBlock')}
        className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${
          unread
            ? 'text-[var(--color-danger)] border border-[var(--color-danger)]'
            : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
        }`}
      >
        <span className="shrink-0">{unread ? '⚠' : '📊'}</span>
        {stats && <span className="shrink-0">{stats.runCount}</span>}
      </button>
      {open && (
        <div
          data-testid="chat-session-stats-panel"
          className="absolute top-full right-0 mt-1 z-50 w-[340px] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-2xl px-3 py-2"
        >
          {unread ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-danger)]">
              <span>{detail}</span>
              <button
                data-testid="chat-session-stats-retry"
                onClick={onRetry}
                className="btn-ghost text-xs shrink-0"
              >
                {t('agent.retryRead')}
              </button>
            </div>
          ) : (
            <>
              <div className="text-xs text-[var(--color-text)]">{detail}</div>
              {stats?.childRuns ? (
                <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  {t('agent.runStatsSemantics')}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}
