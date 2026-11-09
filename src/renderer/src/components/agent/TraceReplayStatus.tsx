import React from 'react'
import type { TraceReplayState } from '../../../../shared/types'
import { useI18n } from '../../i18n'

/**
 * P0-5（渲染端只读接档）：每条 trace 回放状态的**行内徽标**（挂主行右端，不单独占一行）。
 *
 * 前三档来自主进程 `annotateTraceReplay`（判据在 `main/agent/trace-replay.ts`）；
 * **`undefined` 单独成一档「判定不可用」**——主进程在 DB/fs 异常时按约定不附这一颗
 * （`annotateTraceReplay` 只在判定有结果时写 `replay`），渲染层若默认成 `expired`
 * 或 `never_stored`，就是把「这次读不出来」谎报成「已经清理」或「从没存过」。
 *
 * 四态不只靠颜色区分：符号（↺／⧗／∅／!）+ 短词各自不同；成因长句放 `title`
 * （悬停可见），「判定不可用」那句保留"读不出来不等于已清理，也不等于没存过"。
 * 徽标 `shrink-0 whitespace-nowrap ml-auto`：不挤压工具名，也不给每一行加高。
 * 本批只显示状态，不提供任何执行入口（没有回放按钮、dry-run、续跑）。
 */
const BADGE = 'ml-auto shrink-0 whitespace-nowrap rounded border px-1 text-[10px] leading-tight'

export const TraceReplayStatus: React.FC<{ replay?: TraceReplayState }> = ({ replay }) => {
  const { t } = useI18n()
  if (replay === 'replayable') {
    return (
      <span
        data-testid="trace-replay-replayable"
        title={t('agent.traceReplay.replayable')}
        className={`${BADGE} border-[var(--color-success)] text-[var(--color-success)]`}
      >
        <span aria-hidden="true">↺</span> {t('agent.traceReplay.short.replayable')}
      </span>
    )
  }
  if (replay === 'expired') {
    return (
      <span
        data-testid="trace-replay-expired"
        title={t('agent.traceReplay.expired')}
        className={`${BADGE} border-[var(--color-warning)] text-[var(--color-warning)]`}
      >
        <span aria-hidden="true">⧗</span> {t('agent.traceReplay.short.expired')}
      </span>
    )
  }
  if (replay === 'never_stored') {
    return (
      <span
        data-testid="trace-replay-never-stored"
        title={t('agent.traceReplay.neverStored')}
        className={`${BADGE} border-[var(--color-border)] text-[var(--color-text-muted)]`}
      >
        <span aria-hidden="true">∅</span> {t('agent.traceReplay.short.neverStored')}
      </span>
    )
  }
  return (
    <span
      data-testid="trace-replay-unavailable"
      title={t('agent.traceReplay.unavailable')}
      className={`${BADGE} border-[var(--color-danger)] text-[var(--color-danger)] font-medium`}
    >
      <span aria-hidden="true">!</span> {t('agent.traceReplay.short.unavailable')}
    </span>
  )
}
