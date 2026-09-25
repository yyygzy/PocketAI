// Agent 左侧栏：助手选择 + 新建会话 + 历史会话列表（支持内联重命名）
import React, { useEffect, useRef, useState } from 'react'
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
  onRename: (id: string, title: string) => void
}

export const SessionRail: React.FC<Props> = ({
  assistants,
  assistantId,
  onAssistantChange,
  conversations,
  conversationId,
  onSelect,
  onNew,
  onDelete,
  onRename
}) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const keyword = search.trim().toLowerCase()
  const filtered = keyword
    ? conversations.filter((c) => (c.title || '').toLowerCase().includes(keyword))
    : conversations
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
      <div className="relative mb-1.5">
        <input
          className="input text-xs pl-2 py-1"
          placeholder={t('agent.searchSession')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs"
            onClick={() => setSearch('')}
            aria-label={t('common.cancel')}
          >×</button>
        )}
      </div>
      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5 px-0.5">
        {t('agent.sectionSessions')}
      </div>
      <div className="flex-1 overflow-y-auto space-y-1">
        {filtered.length === 0 && (
          <p className="text-[11px] text-[var(--color-text-muted)] px-0.5">
            {keyword ? t('agent.noSearchResult') : t('agent.noSessions')}
          </p>
        )}
        {filtered.map((c) => (
          <SessionItem
            key={c.id}
            conv={c}
            isActive={conversationId === c.id}
            onSelect={() => onSelect(c.id)}
            onDelete={() => onDelete(c.id)}
            onRename={(title) => onRename(c.id, title)}
          />
        ))}
      </div>
    </div>
  )
}

/** 单个会话项：双击或点 ✎ 进入内联重命名，Enter/失焦确认，Esc 取消 */
const SessionItem: React.FC<{
  conv: ConversationRecord
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (title: string) => void
}> = ({ conv, isActive, onSelect, onDelete, onRename }) => {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(conv.title)
    const rafId = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(rafId)
  }, [editing, conv.title])

  const commit = () => {
    const v = draft.trim()
    if (v && v !== conv.title) onRename(v)
    setEditing(false)
  }

  const displayTitle = conv.title || t('agent.defaultConvTitle')

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onDoubleClick={() => setEditing(true)}
      className={`group flex items-center rounded text-xs ${
        editing ? '' : 'cursor-pointer ' + (isActive
          ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
          : 'hover:bg-[var(--color-hover-overlay)]')
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 min-w-0 mx-1 my-0.5 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-1 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <div className="flex-1 min-w-0 px-2 py-1.5">
          <div className="truncate">{displayTitle}</div>
        </div>
      )}
      {!editing && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true) }}
            className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            title={t('chat.rename')}
            aria-label={t('chat.rename')}
          >✎</button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 mr-1 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
            title={t('chat.delete')}
            aria-label={t('chat.delete')}
          >×</button>
        </>
      )}
    </div>
  )
}
