import React from 'react'
import type { ProviderRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { Markdown } from './Markdown'

export interface CompareColumn {
  providerId: string
  model: string
  content: string
  status: 'streaming' | 'done' | 'error' | 'aborted'
  error?: string
}

interface Props {
  columns: CompareColumn[]
  providers: ProviderRecord[]
}

export const ComparisonColumns: React.FC<Props> = ({ columns, providers }) => {
  const { t } = useI18n()
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id

  const badgeOf = (status: CompareColumn['status']): { text: string; cls: string } | null => {
    switch (status) {
      case 'streaming':
        return { text: t('cmp.streaming'), cls: 'text-[var(--color-warning)] bg-[var(--color-warning-bg)]' }
      case 'error':
        return { text: t('cmp.error'), cls: 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]' }
      case 'aborted':
        return { text: t('cmp.aborted'), cls: 'text-[var(--color-text-muted)] bg-[var(--color-hover-overlay)]' }
      default:
        return null
    }
  }

  return (
    <div
      className="grid gap-3 overflow-x-auto pb-2"
      style={{
        gridTemplateColumns: `repeat(${columns.length}, minmax(300px, 1fr))`
      }}
    >
      {columns.map((col, i) => {
        const badge = badgeOf(col.status)
        return (
          <div
            key={i}
            className="flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] min-h-[120px] max-h-[65vh]"
          >
            {/* 列头 */}
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
              <span className="text-xs">🤖</span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                  {nameOf(col.providerId)}
                </div>
                <div className="text-xs font-mono truncate">{col.model}</div>
              </div>
              {badge && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>
                  {col.status === 'streaming' && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse mr-1 align-middle" />
                  )}
                  {badge.text}
                </span>
              )}
            </div>

            {/* 列内容（独立滚动） */}
            <div className="flex-1 overflow-y-auto px-3 py-2.5">
              {col.status === 'error' && !col.content ? (
                <p className="text-xs text-[var(--color-danger)]">{t('cmp.requestFail', { error: col.error ?? '' })}</p>
              ) : col.content ? (
                <>
                  <Markdown content={col.content} />
                  {col.status === 'streaming' && (
                    <span className="inline-block w-2 h-4 mt-1 bg-[var(--color-accent)] animate-pulse align-middle" />
                  )}
                </>
              ) : col.status === 'streaming' ? (
                <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
              ) : (
                <span className="text-xs text-[var(--color-text-muted)]">{t('cmp.empty')}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
