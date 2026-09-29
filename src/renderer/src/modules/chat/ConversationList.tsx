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
  onExportHtml?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onBatchExport?: (format: 'md' | 'html') => void
  onImport?: () => void
  onImportEncrypted?: () => void
  /** 搜索结果点击：跳转定位到匹配消息（convId + messageId） */
  onSelectMessage?: (convId: string, messageId: string) => void
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
  onExportHtml,
  onExportEncrypted,
  onBatchExport,
  onImport,
  onImportEncrypted,
  onSelectMessage,
  embedded
}) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<MessageSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [dateFilter, setDateFilter] = useState<'all' | '7d' | '30d' | 'custom'>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const PAGE = 50

  // 日期筛选 → dateRange 参数
  const dateRange = (() => {
    if (dateFilter === 'all') return undefined
    if (dateFilter === 'custom') {
      const r: { from?: number; to?: number } = {}
      if (customFrom) r.from = new Date(customFrom).getTime()
      if (customTo) r.to = new Date(customTo).getTime() + 86_400_000 // 含当天全天
      return r
    }
    const days = dateFilter === '7d' ? 7 : 30
    return { from: Date.now() - days * 86_400_000 }
  })()

  // 搜索（首页）
  useEffect(() => {
    if (!search.trim()) {
      setResults([])
      setHasMore(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      setOffset(0)
      try {
        const r = await window.pocketai.searchMessages(search.trim(), null, dateRange, 0)
        setResults(r)
        setHasMore(r.length === PAGE)
      } catch (e) {
        logIpcError('chat.searchMessages', e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [search, dateFilter, customFrom, customTo, dateRange])

  // 加载更多
  const loadMore = async () => {
    if (loadingMore || !search.trim()) return
    setLoadingMore(true)
    try {
      const next = offset + PAGE
      const r = await window.pocketai.searchMessages(search.trim(), null, dateRange, next)
      setResults((prev) => [...prev, ...r])
      setOffset(next)
      setHasMore(r.length === PAGE)
    } catch (e) {
      logIpcError('chat.searchMessages.loadMore', e)
    } finally {
      setLoadingMore(false)
    }
  }

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
          {onBatchExport && (
            <ExportMenu
              triggerTitle={t('chat.exportBatch')}
              triggerContent="📤"
              triggerClassName="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
              items={[
                { key: 'md', label: t('chat.exportBatchMd') },
                { key: 'html', label: t('chat.exportBatchHtml') }
              ]}
              onPick={(k) => onBatchExport(k as 'md' | 'html')}
            />
          )}
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
        {isSearching && (
          <div className="flex flex-wrap gap-1">
            {(['all', '7d', '30d', 'custom'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setDateFilter(f)}
                className={`text-[10px] px-1.5 py-0.5 rounded ${dateFilter === f ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
              >
                {t(`chat.searchDate${f === 'all' ? 'All' : f === '7d' ? '7d' : f === '30d' ? '30d' : 'Custom'}`)}
              </button>
            ))}
          </div>
        )}
        {isSearching && dateFilter === 'custom' && (
          <div className="flex gap-1 text-[10px]">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="input text-[10px] px-1 py-0.5 flex-1" />
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="input text-[10px] px-1 py-0.5 flex-1" />
          </div>
        )}
      </div>

      {/* 结果区 / 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {isSearching ? (
          <MessageSearchResults
            results={results}
            searching={searching}
            query={search}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onSelectConv={onSelect}
            onSelectMessage={(convId, msgId) => {
              onSelectMessage ? onSelectMessage(convId, msgId) : onSelect(convId)
            }}
            onLoadMore={loadMore}
          />
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
              onExportHtml={onExportHtml}
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
  onExportHtml?: (id: string) => void
  onExportEncrypted?: (id: string) => void
}> = ({ conv, isActive, onSelect, onDelete, onRename, onExport, onExportHtml, onExportEncrypted }) => {
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
      {(onExport || onExportHtml) && !editing && (
        <ExportMenu
          triggerTitle={t('chat.exportMenu')}
          triggerContent="↓"
          triggerClassName="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          items={[
            ...(onExport ? [{ key: 'md', label: t('chat.exportMd') }] : []),
            ...(onExportHtml ? [{ key: 'html', label: t('chat.exportHtml') }] : [])
          ]}
          onPick={(k) => (k === 'html' ? onExportHtml?.(conv.id) : onExport?.(conv.id))}
        />
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

/** 下拉小菜单（导出格式选择）：点外部/Esc 关闭；点击与菜单项均阻止冒泡防穿透到会话行 */
export const ExportMenu: React.FC<{
  triggerTitle: string
  triggerContent: React.ReactNode
  triggerClassName: string
  items: Array<{ key: string; label: string }>
  onPick: (key: string) => void
}> = ({ triggerTitle, triggerContent, triggerClassName, items, onPick }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        title={triggerTitle}
        aria-label={triggerTitle}
        className={triggerClassName}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      >{triggerContent}</button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-0.5 min-w-[140px] py-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] whitespace-nowrap"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                onPick(it.key)
              }}
            >{it.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

