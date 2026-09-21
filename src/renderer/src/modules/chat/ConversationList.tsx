import React, { useState, useEffect, useRef } from 'react'
import type { ConversationRecord } from '../../../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../../../shared/snippet'
import { useI18n } from '../../i18n'

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

interface SearchResult {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: string
  content: string
  snippet: string
  createdAt: number
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
  const [results, setResults] = useState<SearchResult[]>([])
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
      } catch {
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
          <SearchResults results={results} searching={searching} query={search} onSelectConv={onSelect} />
        ) : (
          conversations.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2">
              {t('chat.noConversations')}
            </p>
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
    if (editing) {
      setDraft(conv.title)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
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
        >↓</button>
      )}
      {onExportEncrypted && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onExportEncrypted(conv.id) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.exportEncrypted')}
        >🔐</button>
      )}
      {onRename && !editing && (
        <button
          onClick={(e) => { e.stopPropagation(); setEditing(true) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.rename')}
        >✎</button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] w-4 h-4 flex items-center justify-center text-xs"
        title={t('chat.delete')}
      >×</button>
    </div>
  )
}

/** 将「纯文本 + PUA 高亮令牌」片段渲染为 React 节点：
 *  全程文本节点，任何 HTML/脚本字符都按字面显示，无注入面 */
const HighlightedSnippet: React.FC<{ text: string }> = ({ text }) => {
  const segments = text.split(SNIPPET_MARK_OPEN)
  return (
    <>
      {segments.map((seg, i) => {
        if (i === 0) return <React.Fragment key={i}>{seg}</React.Fragment>
        const at = seg.indexOf(SNIPPET_MARK_CLOSE)
        if (at < 0) return <React.Fragment key={i}>{seg}</React.Fragment>
        return (
          <React.Fragment key={i}>
            <mark className="bg-[var(--color-accent-soft)] text-[var(--color-text)] rounded px-0.5 font-medium">
              {seg.slice(0, at)}
            </mark>
            {seg.slice(at + SNIPPET_MARK_CLOSE.length)}
          </React.Fragment>
        )
      })}
    </>
  )
}

/** Unix 毫秒时间戳 → 相对人类可读时间（1分钟前、2小时前、昨天、日期） */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const y = new Date(now.getTime() - 86_400_000)
  if (d.toDateString() === y.toDateString()) return '昨天'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const SearchResults: React.FC<{
  results: SearchResult[]
  searching: boolean
  query: string
  onSelectConv: (convId: string) => void
}> = ({ results, searching, query, onSelectConv }) => {
  const { t } = useI18n()
  if (searching) {
    return <p className="text-xs text-[var(--color-text-muted)] text-center mt-6">{t('chat.searching')}</p>
  }
  if (results.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2">{t('chat.noResult', { query })}</p>
  }
  // 按 conversationId 分组
  const grouped = new Map<string, { title: string; items: SearchResult[] }>()
  for (const r of results) {
    const g = grouped.get(r.conversationId) ?? { title: r.conversationTitle, items: [] }
    g.items.push(r)
    grouped.set(r.conversationId, g)
  }
  return (
    <>
      <p className="text-[11px] text-[var(--color-text-muted)] px-1 py-1">{t('chat.resultCount', { n: results.length, m: grouped.size })}</p>
      {[...grouped.entries()].map(([convId, group]) => (
        <div key={convId} className="mb-2">
          <button
            onClick={() => onSelectConv(convId)}
            className="w-full text-left text-[11px] text-[var(--color-accent)] px-2 py-0.5 hover:underline truncate"
            title={group.title}
          >
            📁 {group.title}
          </button>
          {group.items.map((r) => (
            <div
              key={r.messageId}
              onClick={() => onSelectConv(r.conversationId)}
              className="text-[11px] px-2.5 py-1.5 rounded cursor-pointer hover:bg-[var(--color-hover-overlay)] border border-transparent hover:border-[var(--color-border)]"
            >
              <div className="flex items-center gap-1 mb-0.5">
                <span className={`inline-block text-[var(--color-text-muted)] ${r.role === 'user' ? 'text-[var(--color-info)]' : r.role === 'assistant' ? 'text-[var(--color-success)]' : ''}`}>
                  {r.role === 'user' ? t('chat.roleYou') : r.role === 'assistant' ? t('chat.roleAI') : r.role}
                </span>
                <span className="text-[var(--color-text-muted)] opacity-60">· {relTime(r.createdAt)}</span>
              </div>
              <span className="text-[var(--color-text)] leading-snug"><HighlightedSnippet text={r.snippet} /></span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
