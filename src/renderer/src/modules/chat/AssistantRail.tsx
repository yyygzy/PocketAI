import React, { useState } from 'react'
import type { AssistantRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'

interface Props {
  assistants: AssistantRecord[]
  activeId: string
  onSelect: (id: string) => void
  onEdit?: (id: string) => void
  onOpenMarket: () => void
  onExport?: () => void
  onImport?: () => void
}

export const AssistantRail: React.FC<Props> = ({ assistants, activeId, onSelect, onEdit, onOpenMarket, onExport, onImport }) => {
  const { t } = useI18n()
  // 助手搜索：名称/描述大小写不敏感过滤；空串显示全部
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const filtered = kw
    ? assistants.filter((a) => a.name.toLowerCase().includes(kw) || a.description.toLowerCase().includes(kw))
    : assistants
  return (
    <div className="shrink-0 border-b border-[var(--color-border)]">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{t('rail.assistant')}</span>
        <div className="flex items-center gap-2">
          {onImport && (
            <button
              onClick={onImport}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              title={t('rail.importTitle')}
            >
              {t('rail.import')}
            </button>
          )}
          {onExport && (
            <button
              onClick={onExport}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              title={t('rail.exportTitle')}
            >
              {t('rail.export')}
            </button>
          )}
          <button
            onClick={onOpenMarket}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] flex items-center gap-1"
            title={t('rail.marketTitle')}
          >
            {t('rail.market')}
          </button>
        </div>
      </div>
      <div className="px-2 pb-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('rail.searchPh')}
          className="w-full h-7 px-2 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
      </div>
      <div className="max-h-44 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">{t('rail.searchEmpty')}</div>
        )}
        {filtered.map((a) => (
          <div
            key={a.id}
            onClick={() => onSelect(a.id)}
            title={a.description}
            className={`group w-full flex items-center gap-2 px-2 py-1.5 rounded text-[13px] cursor-pointer ${
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
            {!a.isBuiltin && onEdit && (
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(a.id) }}
                className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs shrink-0"
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >✎</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
