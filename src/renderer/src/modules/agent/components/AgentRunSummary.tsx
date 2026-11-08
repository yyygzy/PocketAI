import React, { useState } from 'react'
import type { AgentRunIndexEntry } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { formatRunDuration } from '../agent-shared'
import { AgentRunInspector } from './AgentRunInspector'

interface AgentRunSummaryProps {
  run: AgentRunIndexEntry
  /** 刚从这一轮跑完时高亮一下，帮助用户把视线落到本轮摘要（P2 / V4-Iter-459） */
  highlight?: boolean
  /** 子会话入口：从轮次里的子 run 进对应子会话 */
  onOpenSubSession?: (conversationId: string) => void
}

/**
 * P2（V4-Iter-459）：挂在助手轮次下的一行「本轮记录」摘要。
 *
 * 摘要常驻、检查器按需展开：默认只放数字（步数 / 耗时 / token / 变更数 / 子代理），
 * 点开才挂载 `AgentRunInspector` 读库——折叠态不产生任何查询。
 * `run.changeCount` 为 `undefined` 时**不写 0**——那是「没记录变更清单」，不是「没有变更」。
 */
export const AgentRunSummary: React.FC<AgentRunSummaryProps> = ({ run, highlight, onOpenSubSession }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[11px] text-[var(--color-text-muted)]">
      <div
        className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 ${
          highlight ? 'rounded bg-[var(--color-bg-secondary)] ring-1 ring-[var(--color-accent)]' : ''
        }`}
        data-testid="agent-run-summary"
        data-request-id={run.requestId}
      >
        <span className="font-medium text-[var(--color-text)]">{t('agent.runSummaryTitle')}</span>
        <span>·</span>
        <span>
          {t('agent.runStats', {
            steps: run.stepCount,
            duration: formatRunDuration(run.totalDurationMs),
            tokens: run.totalTokens.toLocaleString('en-US')
          })}
        </span>
        {run.changeCount !== undefined && (
          <span>· {t('agent.runSummaryChanges', { count: run.changeCount })}</span>
        )}
        {run.childRuns !== undefined && run.childRuns > 0 && (
          <span>{t('agent.runStatsChildren', { n: run.childRuns })}</span>
        )}
        {run.errorSteps > 0 && (
          <span className="text-[var(--color-danger)]">· {t('agent.runSummaryErrors', { count: run.errorSteps })}</span>
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t('agent.runSummaryCollapse') : t('agent.runSummaryExpand')}
          title={open ? t('agent.runSummaryCollapse') : t('agent.runSummaryExpand')}
          data-testid="agent-run-summary-toggle"
          className="ml-auto px-1 rounded hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors"
        >
          {open ? '▾' : '▸'}
        </button>
      </div>
      {open && <AgentRunInspector run={run} onOpenSubSession={onOpenSubSession} />}
    </div>
  )
}
