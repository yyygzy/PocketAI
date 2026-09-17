import React from 'react'
import type { AssistantRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'

interface Props {
  assistants: AssistantRecord[]
  activeId: string
  onSelect: (id: string) => void
  onOpenMarket: () => void
}

export const AssistantRail: React.FC<Props> = ({ assistants, activeId, onSelect, onOpenMarket }) => {
  const { t } = useI18n()
  return (
    <div className="shrink-0 border-b border-[var(--color-border)]">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{t('rail.assistant')}</span>
        <button
          onClick={onOpenMarket}
          className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] flex items-center gap-1"
          title={t('rail.marketTitle')}
        >
          {t('rail.market')}
        </button>
      </div>
      <div className="max-h-44 overflow-y-auto px-2 pb-2 space-y-0.5">
        {assistants.map((a) => (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            title={a.description}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[13px] ${
              activeId === a.id
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'hover:bg-[var(--color-hover-overlay)] text-[var(--color-text)]'
            }`}
          >
            <span className="text-base shrink-0">{a.avatar}</span>
            <span className="flex-1 text-left truncate">{a.name}</span>
            {!a.isBuiltin && (
              <span className="text-[9px] px-1 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)] shrink-0">
                {t('rail.mine')}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
