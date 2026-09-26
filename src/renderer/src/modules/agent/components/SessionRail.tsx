// Agent 左侧栏：助手选择 + 新建会话 + 历史会话列表（支持内联重命名、消息全文搜索）
import React, { useEffect, useRef, useState } from 'react'
import type { AssistantRecord, ConversationRecord, MessageSearchResult } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { MessageSearchResults } from '../../../components/MessageSearchResults'
import { logIpcError } from '../../../utils/ipc'

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
  onExport?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onImport?: () => void
  onImportEncrypted?: () => void
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
  onRename,
  onExport,
  onExportEncrypted,
  onImport,
  onImportEncrypted
}) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const keyword = search.trim()
  const [results, setResults] = useState<MessageSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  // 全文搜索（debounce 200ms，按当前助手隔离；与 Chat 侧栏同一后端通道）
  useEffect(() => {
    if (!keyword) {
      setResults([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        setResults(await window.pocketai.searchMessages(keyword, assistantId || undefined))
      } catch (e) {
        logIpcError('agent.searchMessages', e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, assistantId])

  // 点搜索结果 → 进入对应会话并退出搜索态
  const handleSelectResult = (id: string) => {
    onSelect(id)
    setSearch('')
  }
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
      <div className="flex gap-1 mb-2">
        <button
          onClick={onNew}
          disabled={!assistantId}
          className="flex-1 text-xs px-2 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40"
        >
          {t('agent.newSession')}
        </button>
        {onImport && (
          <button
            onClick={onImport}
            disabled={!assistantId}
            className="text-xs px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap disabled:opacity-40"
            title={t('chat.import')}
            aria-label={t('chat.import')}
          >⬇ {t('chat.importShort')}</button>
        )}
        {onImportEncrypted && (
          <button
            onClick={onImportEncrypted}
            disabled={!assistantId}
            className="text-xs px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap disabled:opacity-40"
            title={t('chat.importEncrypted')}
            aria-label={t('chat.importEncrypted')}
          >🔐</button>
        )}
      </div>
      <div className="relative mb-1.5">
        <input
          className="input text-xs pl-2 py-1"
          placeholder={t('chat.searchPlaceholder')}
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
        {keyword ? (
          <MessageSearchResults
            results={results}
            searching={searching}
            query={keyword}
            onSelectConv={handleSelectResult}
          />
        ) : (
          <>
            {conversations.length === 0 && (
              <p className="text-[11px] text-[var(--color-text-muted)] px-0.5">
                {t('agent.noSessions')}
              </p>
            )}
            {conversations.map((c) => (
              <SessionItem
                key={c.id}
                conv={c}
                isActive={conversationId === c.id}
                onSelect={() => onSelect(c.id)}
                onDelete={() => onDelete(c.id)}
                onRename={(title) => onRename(c.id, title)}
                onExport={onExport ? () => onExport(c.id) : undefined}
                onExportEncrypted={onExportEncrypted ? () => onExportEncrypted(c.id) : undefined}
              />
            ))}
          </>
        )}
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
  onExport?: () => void
  onExportEncrypted?: () => void
}> = ({ conv, isActive, onSelect, onDelete, onRename, onExport, onExportEncrypted }) => {
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
          {onExport && (
            <button
              onClick={(e) => { e.stopPropagation(); onExport() }}
              className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              title={t('chat.export')}
              aria-label={t('chat.export')}
            >↓</button>
          )}
          {onExportEncrypted && (
            <button
              onClick={(e) => { e.stopPropagation(); onExportEncrypted() }}
              className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              title={t('chat.exportEncrypted')}
              aria-label={t('chat.exportEncrypted')}
            >🔐</button>
          )}
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
