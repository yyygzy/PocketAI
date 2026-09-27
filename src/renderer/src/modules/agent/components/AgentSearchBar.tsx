// 会话内消息搜索栏：输入关键词，上/下一个命中，Esc/× 关闭
import React, { useEffect, useRef } from 'react'
import { useI18n } from '../../../i18n'

interface Props {
  query: string
  onQueryChange: (v: string) => void
  /** 当前命中序号（0 起）；无命中时为 -1 */
  activeHit: number
  hitCount: number
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}

export const AgentSearchBar: React.FC<Props> = ({
  query,
  onQueryChange,
  activeHit,
  hitCount,
  onPrev,
  onNext,
  onClose
}) => {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开即聚焦
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const noMatch = query.trim().length > 0 && hitCount === 0

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--color-border)]">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        placeholder={t('agent.searchPh')}
        className="flex-1 min-w-0 h-7 px-2 text-sm rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] outline-none focus:border-[var(--color-accent)]"
      />
      <span
        className={`shrink-0 text-[11px] tabular-nums ${noMatch ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
        title={t('agent.searchNavHint')}
      >
        {query.trim()
          ? noMatch
            ? t('agent.searchNoResult')
            : `${activeHit + 1}/${hitCount}`
          : ''}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={hitCount === 0}
        title={t('agent.searchPrev')}
        aria-label={t('agent.searchPrev')}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={hitCount === 0}
        title={t('agent.searchNext')}
        aria-label={t('agent.searchNext')}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={onClose}
        title={t('common.cancel')}
        aria-label={t('common.cancel')}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-danger)] transition-colors"
      >
        ×
      </button>
    </div>
  )
}
