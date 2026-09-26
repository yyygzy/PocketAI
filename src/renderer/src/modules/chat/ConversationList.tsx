import React, { useState, useEffect, useRef } from 'react'
import type { ConversationRecord, MessageSearchResult } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { MessageSearchResults } from '../../components/MessageSearchResults'
import { logIpcError } from '../../utils/ipc'

interface Props {
  conversations: ConversationRecord[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename?: (id: string, title: string) => void
  onExport?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onImport?: () => void
  onImportEncrypted?: () => void
  /** 嵌入到已有侧栏容器时，去掉自身宽度/边框/背景 */
  embedded?: boolean
}

export const ConversationList: React.FC<Props> = ({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onExport,
  onExportEncrypted,
  onImport,
  onImportEncrypted,
  embedded
}) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<MessageSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    if (!search.trim()) {
      setResults([])
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await window.pocketai.searchMessages(search.trim())
        setResults(r)
      } catch (e) {
        logIpcError('chat.searchMessages', e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search])

  const isSearching = search.trim().length > 0

  return (
    <div className={embedded ? 'flex flex-col h-full min-h-0' : 'w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)]'}>
      {/* 搜索框 */}
      <div className="p-2 space-y-2">
        <div className="relative">
          <input
            className="input text-xs pl-7"
            placeholder={t('chat.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs"
              onClick={() => setSearch('')}
            >×</button>
          )}
        </div>
        <div className="flex gap-1">
          <button
            onClick={onNew}
            className="flex-1 text-sm px-3 py-2 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 font-medium"
          >
            {t('chat.newConversation')}
          </button>
          {onImport && (
            <button
              onClick={onImport}
              className="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
              title={t('chat.import')}
            >⬇ {t('chat.importShort')}</button>
          )}
          {onImportEncrypted && (
            <button
              onClick={onImportEncrypted}
              className="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
              title={t('chat.importEncrypted')}
            >🔐 {t('chat.importEncryptedShort')}</button>
          )}
        </div>
      </div>

      {/* 结果区 / 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {isSearching ? (
          <MessageSearchResults results={results} searching={searching} query={search} onSelectConv={onSelect} />
        ) : (
          conversations.length === 0 ? (
            <EmptyState className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2" message={t('chat.noConversations')} />
          ) : conversations.map((c) => (
            <ConvItem
              key={c.id}
              conv={c}
              isActive={currentId === c.id}
              onSelect={() => onSelect(c.id)}
              onDelete={() => onDelete(c.id)}
              onRename={onRename ? (title) => onRename(c.id, title) : undefined}
              onExport={onExport}
              onExportEncrypted={onExportEncrypted}
            />
          ))
        )}
      </div>
    </div>
  )
}

const ConvItem: React.FC<{
  conv: ConversationRecord
  isActive: boolean
  onSelect: () => void
  onDelete: () => void
  onRename?: (title: string) => void
  onExport?: (id: string) => void
  onExportEncrypted?: (id: string) => void
}> = ({ conv, isActive, onSelect, onDelete, onRename, onExport, onExportEncrypted }) => {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(conv.title)
    let rafId: number
    rafId = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(rafId)
  }, [editing, conv.title])

  const commit = () => {
    const v = draft.trim()
    if (v && v !== conv.title) onRename?.(v)
    setEditing(false)
  }

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onDoubleClick={() => onRename && setEditing(true)}
      className={`group flex items-center gap-1 px-2.5 py-2 rounded text-sm ${
        editing ? '' : 'cursor-pointer ' + (isActive
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'hover:bg-[var(--color-hover-overlay)] text-[var(--color-text)]')
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-1 py-0.5 text-sm outline-none focus:border-[var(--color-accent)]"
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
        <span className="flex-1 truncate">{conv.title}</span>
      )}
      {onExport && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onExport(conv.id) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.export')}
          aria-label={t('chat.export')}
        >↓</button>
      )}
      {onExportEncrypted && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onExportEncrypted(conv.id) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.exportEncrypted')}
          aria-label={t('chat.exportEncrypted')}
        >🔐</button>
      )}
      {onRename && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.rename')}
          aria-label={t('chat.rename')}
        >✎</button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] w-4 h-4 flex items-center justify-center text-xs"
        title={t('chat.delete')}
        aria-label={t('chat.delete')}
      >×</button>
    </div>
  )
}

