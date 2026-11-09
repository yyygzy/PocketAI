// 运行分步明细列表（Agent 调试台与对话页轮次检查器共用的唯一一份）
import React, { useState } from 'react'
import type {
  AgentTraceRecord,
  ConversationRecord,
  WorkspaceChangeDegradedReason,
  WorkspaceChangeEntry
} from '../../../../shared/types'
import { parseWorkspaceChangeSet } from '../../../../shared/workspace-changes'
import { useI18n } from '../../i18n'
import { formatBytes } from '../../utils/format'
import { formatStepTokens } from '../../utils/agent-step-tokens'
import { formatRunDuration } from './agent-shared'
import { TraceReplayStatus } from './TraceReplayStatus'

interface AgentTraceListProps {
  traces: AgentTraceRecord[]
  /**
   * 每步的子会话入口解析：Agent 壳按委派返回值里的 8 位前缀命中直接子会话；
   * 对话页轮次检查器不按步给入口（它用 run 索引里的 `childConversationIds` 另列一处）。
   * 不传 = 不渲染每步入口。
   */
  resolveSubSessions?: (trace: AgentTraceRecord) => ConversationRecord[]
  onOpenSubSession?: (conversationId: string) => void
}

/**
 * 步骤流 / 每步 token / 变更清单 / replay 的展示本体。
 * 变更清单**只**从 trace 行的 `change_set` 经 `parseWorkspaceChangeSet` 解析，不另起一套解析。
 */
export const AgentTraceList: React.FC<AgentTraceListProps> = ({
  traces,
  resolveSubSessions,
  onOpenSubSession
}) => {
  const { t } = useI18n()
  /** 逐条展开「入参／返回」（键=trace 行 id，天然唯一，切会话不用清） */
  const [ioOpen, setIoOpen] = useState<Record<string, boolean>>({})

  const changeReasonText = {
    'too-many-files': t('agent.traceChangesReason.too-many-files'),
    'too-many-bytes': t('agent.traceChangesReason.too-many-bytes'),
    timeout: t('agent.traceChangesReason.timeout'),
    'too-many-changes': t('agent.traceChangesReason.too-many-changes'),
    'before-scan-failed': t('agent.traceChangesReason.before-scan-failed'),
    'after-scan-failed': t('agent.traceChangesReason.after-scan-failed'),
    'auto-allowed-not-recorded': t('agent.traceChangesReason.auto-allowed-not-recorded')
  } satisfies Record<WorkspaceChangeDegradedReason, string>
  const changeKindText = {
    added: t('agent.traceChangeKind.added'),
    modified: t('agent.traceChangeKind.modified'),
    deleted: t('agent.traceChangeKind.deleted')
  } satisfies Record<WorkspaceChangeEntry['kind'], string>
  const changeContentText = {
    'mtime-only': t('agent.traceChangeContent.mtime-only'),
    binary: t('agent.traceChangeContent.binary'),
    'too-large': t('agent.traceChangeContent.too-large'),
    unreadable: t('agent.traceChangeContent.unreadable')
  } satisfies Record<Exclude<WorkspaceChangeEntry['content'], 'hashed' | 'not-compared'>, string>

  return (
    <>
      {traces.map((tr, i) => {
        const stepTokens = formatStepTokens(tr, t)
        const open = ioOpen[tr.id] ?? false
        // 这一步派出去的那几趟子会话：拿返回值头部里的 8 位前缀去直接子会话中找命中。
        // 一个前缀命中 0 个或 ≥2 个都不给入口（宁可不给，也不赌是哪一趟）；同一步并行委派好几趟时，
        // 每个唯一命中各给一个按钮。
        const kids = onOpenSubSession
          ? (resolveSubSessions?.(tr) ?? [])
          : []
        // v55：变更清单是这一步的"执行后事实"，有它才展开；null 与"没有变更"分开说
        const changes = parseWorkspaceChangeSet(tr.changeSet)
        const hasIo = !!(tr.toolArgs || tr.toolResult || tr.model || changes)
        const rowClass = 'flex flex-wrap items-baseline gap-x-1.5'
        const line = (
          <>
            <span className="text-[var(--color-text-muted)]">#{i + 1}</span>
            <span className={tr.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}>
              {tr.status === 'error' ? '✕' : '✓'}
            </span>
            <span>{t(`agent.traceType.${tr.stepType}`)}</span>
            {tr.toolName && <span className="text-[var(--color-accent)]">{tr.toolName}</span>}
            <span className="text-[var(--color-text-muted)]">{formatRunDuration(tr.durationMs ?? 0)}</span>
            {stepTokens && <span className="text-[var(--color-text-muted)]">{stepTokens}</span>}
            {/* 回放状态的行内徽标挂主行右端（ml-auto）：不另起一行，也不挤压工具名 */}
            <TraceReplayStatus replay={tr.replay} />
          </>
        )
        return (
          <div key={tr.id} className="text-xs leading-relaxed">
            {/* 整行就是开关（▸/▾ 与上面那条统计头同一个动作语言）；只有真有东西可展开时它才是按钮 */}
            {hasIo ? (
              <button
                type="button"
                onClick={() => setIoOpen((p) => ({ ...p, [tr.id]: !open }))}
                aria-expanded={open}
                data-testid={`trace-io-${tr.id}`}
                title={t('agent.traceIo')}
                className={`${rowClass} w-full text-left hover:opacity-70 transition-opacity`}
              >
                <span className="w-3 inline-block text-[var(--color-text-muted)]">{open ? '▾' : '▸'}</span>
                {line}
              </button>
            ) : (
              <div className={rowClass}>{line}</div>
            )}
            {tr.error && (
              <div className="ml-4 text-[var(--color-danger)] whitespace-pre-wrap break-all">{tr.error}</div>
            )}
            {/* 子会话入口单独一行：嵌进整行按钮里会把点击搞糊（点开子会话不该顺手收起这一行） */}
            {kids.length > 0 && onOpenSubSession && (
              <div className="ml-4 mt-0.5 flex flex-wrap gap-x-1.5">
                {kids.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => onOpenSubSession(k.id)}
                    data-testid={`trace-open-sub-${tr.id}`}
                    className="px-1 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:opacity-80 transition-opacity"
                  >
                    {t('agent.openSubSession')}
                  </button>
                ))}
              </div>
            )}
            {hasIo && open && (
              <div className="ml-4 mt-1 space-y-1">
                {tr.model && (
                  <div data-testid="trace-model" className="text-[var(--color-text-muted)]">
                    {t('agent.traceModel')}：{tr.model}
                  </div>
                )}
                {tr.toolArgs && (
                  <div
                    data-testid="trace-args"
                    className="max-h-40 overflow-y-auto px-1.5 py-1 rounded border border-[var(--color-border)] whitespace-pre-wrap break-all"
                  >
                    {t('agent.traceArgs')}：{tr.toolArgs}
                  </div>
                )}
                {tr.toolResult && (
                  <div
                    data-testid="trace-result"
                    className="max-h-40 overflow-y-auto px-1.5 py-1 rounded border border-[var(--color-border)] whitespace-pre-wrap break-all"
                  >
                    {t('agent.traceResult')}：{tr.toolResult}
                  </div>
                )}
                {changes && (
                  <div data-testid="trace-changes" className="px-1.5 py-1 rounded border border-[var(--color-border)]">
                    {changes.status === 'degraded' ? (
                      <div className="text-[var(--color-text-muted)]">
                        {t('agent.traceChangesDegraded', {
                          reason: changes.degradedReason ? changeReasonText[changes.degradedReason] : ''
                        })}
                      </div>
                    ) : (
                      <>
                        {changes.entries.length === 0 ? (
                          <div className="text-[var(--color-text-muted)]">{t('agent.traceChangesNone')}</div>
                        ) : (
                          <>
                            <div className="text-[var(--color-text-muted)]">
                              {t('agent.traceChangesTitle', {
                                count: changes.entries.length,
                                added: changes.counts.added,
                                modified: changes.counts.modified,
                                deleted: changes.counts.deleted
                              })}
                            </div>
                            <ul className="mt-1 max-h-40 overflow-y-auto">
                              {changes.entries.map((e) => (
                                <li key={`${e.kind}:${e.path}`} className="whitespace-pre-wrap break-all">
                                  {changeKindText[e.kind]} {e.path} ({formatBytes(e.size)})
                                  {e.content !== 'hashed' && e.content !== 'not-compared'
                                    ? ` · ${changeContentText[e.content]}`
                                    : ''}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {/* 口径说明：自动放行的调用不做扫描，别让这份清单被读成"本步全部变更" */}
                        <div className="mt-1 text-[var(--color-text-muted)]">{t('agent.traceChangesScope')}</div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {!hasIo && (
              // 这三列是 v50 才有的：旧行留 NULL。空白会被读成"这一步什么都没传"，
              // 所以要说"没记录"，不能演成"没有"（§222 那一族）
              <div data-testid="trace-no-io" className="ml-4 text-[var(--color-text-muted)]">
                {t('agent.traceNoIo')}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
