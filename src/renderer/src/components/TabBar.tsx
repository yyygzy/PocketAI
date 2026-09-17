import React from 'react'
import { useI18n } from '../i18n'

export interface Tab {
  id: string
  title: string
  moduleId: string
  pinned?: boolean
}

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew
}) => {
  const { t } = useI18n()

  return (
    <div className="flex items-center h-9 bg-[var(--color-sidebar)] border-b border-[var(--color-border)] px-1 gap-0.5 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={`group flex items-center gap-2 h-7 px-3 rounded text-xs cursor-pointer whitespace-nowrap shrink-0 ${
            activeTabId === tab.id
              ? 'bg-[var(--color-surface)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)]'
          }`}
        >
          {tab.pinned && <span title={t('tab.pinned')}>📌</span>}
          <span className="max-w-[120px] truncate">{tab.title}</span>
          {!tab.pinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              className="opacity-0 group-hover:opacity-100 hover:bg-[var(--color-hover-overlay)] rounded w-4 h-4 flex items-center justify-center text-[10px]"
              title={t('tab.close')}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <button
        onClick={onNew}
        className="h-7 w-7 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] shrink-0"
        title={t('tab.new')}
      >
        +
      </button>
    </div>
  )
}
