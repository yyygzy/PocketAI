// Agent 左侧栏：助手选择 + 新建会话 + 历史会话列表
import React from 'react'
import type { AssistantRecord, ConversationRecord } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'

interface Props {
  assistants: AssistantRecord[]
  assistantId: string
  onAssistantChange: (id: string) => void
  conversations: ConversationRecord[]
  conversationId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export const SessionRail: React.FC<Props> = ({
  assistants,
  assistantId,
  onAssistantChange,
  conversations,
  conversationId,
  onSelect,
  onNew,
  onDelete
}) => {
  const { t } = useI18n()
  return (
    <div className="w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-lg p-2">
      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5 px-0.5">
        {t('agent.sectionAssistant')}
      </div>
      <select
        className="select-mini w-full mb-2"
        value={assistantId}
        onChange={(e) => onAssistantChange(e.target.value)}
      >
        <option value="">{t('agent.selectAssistant')}</option>
        {assistants.map((a) => (
          <option key={a.id} value={a.id}>{a.avatar} {a.name}</option>
        ))}
      </select>
      <button
        onClick={onNew}
        disabled={!assistantId}
        className="text-xs px-2 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40 mb-2"
      >
        {t('agent.newSession')}
      </button>
      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5 px-0.5">
        {t('agent.sectionSessions')}
      </div>
      <div className="flex-1 overflow-y-auto space-y-1">
        {conversations.length === 0 && (
          <p className="text-[11px] text-[var(--color-text-muted)] px-0.5">{t('agent.noSessions')}</p>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded text-xs ${
              conversationId === c.id
                ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                : 'hover:bg-[var(--color-hover-overlay)]'
            }`}
          >
            <button
              onClick={() => onSelect(c.id)}
              className="flex-1 min-w-0 text-left px-2 py-1.5"
            >
              <div className="truncate">{c.title || t('agent.defaultConvTitle')}</div>
            </button>
            <button
              onClick={() => onDelete(c.id)}
              className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 mr-1 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              title={t('chat.delete')}
            >×</button>
          </div>
        ))}
      </div>
    </div>
  )
}
