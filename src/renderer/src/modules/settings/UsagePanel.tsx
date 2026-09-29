// 用量统计面板：token 用量汇总 + 按日趋势（纯 CSS 柱状图）+ provider/模型排行
// 数据来源：messages.usage（chat/agent 生成完成时落库），IPC getUsageSummary 聚合
import React, { useCallback, useEffect, useState } from 'react'
import type { UsageSummary } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError } from '../../utils/ipc'

/** token 数量级缩写：<1000 原样，≥1000 显示 k，≥1M 显示 M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

const RANGES = [7, 30, 90] as const

export const UsagePanel: React.FC = () => {
  const { t } = useI18n()
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)

  const load = useCallback((d: number) => {
    window.pocketai.getUsageSummary(d).then(setSummary).catch(reportIpcError('usage.get'))
  }, [])

  useEffect(() => {
    load(days)
  }, [load, days])

  const maxDaily = summary ? Math.max(...summary.daily.map((d) => d.totalTokens), 1) : 1
  const maxProvider = summary && summary.byProvider.length > 0 ? summary.byProvider[0]!.totalTokens : 1

  return (
    <div>
      {/* 范围切换 */}
      <div className="flex gap-1.5 mb-3">
        {RANGES.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`chip ${days === d ? 'chip-accent' : ''}`}
          >
            {t(`usage.days${d}`)}
          </button>
        ))}
      </div>

      {!summary ? (
        <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
      ) : summary.totals.requests === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] py-3">{t('usage.noData')}</div>
      ) : (
        <>
          {/* 汇总卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <StatCard label={t('usage.requests')} value={String(summary.totals.requests)} />
            <StatCard label={t('usage.totalTokens')} value={fmtTokens(summary.totals.totalTokens)} />
            <StatCard label={t('usage.prompt')} value={fmtTokens(summary.totals.promptTokens)} />
            <StatCard label={t('usage.completion')} value={fmtTokens(summary.totals.completionTokens)} />
          </div>
          {summary.totals.cachedTokens > 0 && (
            <div className="text-[11px] text-[var(--color-text-muted)] mb-3">
              {t('usage.cached', { count: fmtTokens(summary.totals.cachedTokens) })}
            </div>
          )}

          {/* 按日趋势柱状图（纯 CSS，无图表库依赖） */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.daily')}</div>
          <div className="flex items-end gap-[2px] h-24 mb-3" role="img" aria-label={t('usage.daily')}>
            {summary.daily.map((d) => {
              const pct = Math.round((d.totalTokens / maxDaily) * 100)
              return (
                <div
                  key={d.date}
                  className="flex-1 min-w-[3px] rounded-t bg-[var(--color-accent)] opacity-80 hover:opacity-100"
                  style={{ height: `${Math.max(pct, d.totalTokens > 0 ? 3 : 1)}%` }}
                  title={`${d.date} · ${fmtTokens(d.totalTokens)}`}
                />
              )
            })}
          </div>
          <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] mb-4">
            <span>{summary.daily[0]?.date}</span>
            <span>{summary.daily[summary.daily.length - 1]?.date}</span>
          </div>

          {/* Provider 排行 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byProvider')}</div>
          <div className="flex flex-col gap-1.5 mb-4">
            {summary.byProvider.map((p) => (
              <div key={p.provider}>
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-[var(--color-text)] truncate">{p.provider}</span>
                  <span className="text-[var(--color-text-muted)] shrink-0 ml-2">
                    {fmtTokens(p.totalTokens)} · {t('usage.requestCount', { count: p.requests })}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-[var(--color-sidebar)] overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--color-accent)] opacity-80"
                    style={{ width: `${Math.max((p.totalTokens / maxProvider) * 100, 2)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* 模型 Top10 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byModel')}</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th className="py-1 pr-2 font-normal">{t('usage.model')}</th>
                <th className="py-1 pr-2 font-normal text-right">{t('usage.requests')}</th>
                <th className="py-1 font-normal text-right">{t('usage.totalTokens')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={`${m.provider}::${m.model}`} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2 truncate max-w-0">
                    <span className="text-[var(--color-text)]">{m.model}</span>
                    <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{m.provider}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[var(--color-text-muted)]">{m.requests}</td>
                  <td className="py-1.5 text-right font-mono text-[var(--color-text)]">{fmtTokens(m.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5">{value}</div>
  </div>
)
