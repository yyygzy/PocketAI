// Agent 左侧栏：助手选择 + 新建会话 + 历史会话列表（支持内联重命名、消息全文搜索）
import React, { useEffect, useRef, useState } from 'react'
import type { AssistantRecord, ConversationRecord, MessageSearchResult } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { MessageSearchResults } from '../../../components/MessageSearchResults'
import { ExportMenu } from '../../chat/ConversationList'
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
  onExportHtml?: (id: string) => void
  onExportPdf?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onBatchExport?: (format: 'md' | 'html') => void
  /** 多选导出：把选中的会话（按列表显示顺序）交父级导出 */
  onBatchExportSelected?: (format: 'md' | 'html' | 'pdf', convs: ConversationRecord[]) => void
  /** 归档区会话（底部折叠展示） */
  archivedConversations?: ConversationRecord[]
  onTogglePin?: (id: string, pinned: boolean) => void
  onSetArchived?: (id: string, archived: boolean) => void
  onImport?: () => void
  onImportEncrypted?: () => void
  /** 搜索结果点击：跳转定位到匹配消息（convId + messageId） */
  onSelectMessage?: (convId: string, messageId: string) => void
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
  onExportHtml,
  onExportPdf,
  onExportEncrypted,
  onBatchExport,
  onBatchExportSelected,
  archivedConversations,
  onTogglePin,
  onSetArchived,
  onImport,
  onImportEncrypted,
  onSelectMessage
}) => {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // 多选导出模式：与搜索态互斥；选中集合用数组保序（导出按列表显示顺序）
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const keyword = search.trim()
  const [results, setResults] = useState<MessageSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const PAGE = 50

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds([])
  }

  // Esc 退出多选
  useEffect(() => {
    if (!selectMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitSelectMode() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selectMode])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const allSelected = conversations.length > 0 && conversations.every((c) => selectedIds.includes(c.id))
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? [] : conversations.map((c) => c.id))
  }

  const selectedConvs = conversations.filter((c) => selectedIds.includes(c.id))
  const handleExportSelected = (format: 'md' | 'html' | 'pdf') => {
    if (selectedConvs.length === 0) return
    onBatchExportSelected?.(format, selectedConvs)
    exitSelectMode()
  }

  // 全文搜索（debounce 200ms，按当前助手隔离；与 Chat 侧栏同一后端通道）
  useEffect(() => {
    if (!keyword) {
      setResults([])
      setHasMore(false)
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      setOffset(0)
      try {
        const r = await window.pocketai.searchMessages(keyword, assistantId || undefined, undefined, 0)
        setResults(r)
        setHasMore(r.length === PAGE)
      } catch (e) {
        logIpcError('agent.searchMessages', e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [keyword, assistantId])

  // 加载更多
  const loadMore = async () => {
    if (loadingMore || !keyword) return
    setLoadingMore(true)
    try {
      const next = offset + PAGE
      const r = await window.pocketai.searchMessages(keyword, assistantId || undefined, undefined, next)
      setResults((prev) => [...prev, ...r])
      setOffset(next)
      setHasMore(r.length === PAGE)
    } catch (e) {
      logIpcError('agent.searchMessages.loadMore', e)
    } finally {
      setLoadingMore(false)
    }
  }

  // 点搜索结果 → 进入对应会话（带 messageId 定位）并退出搜索态
  const handleSelectResult = (id: string) => {
    onSelect(id)
    setSearch('')
  }
  const handleSelectMessage = (convId: string, messageId: string) => {
    if (onSelectMessage) onSelectMessage(convId, messageId)
    else onSelect(convId)
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
        {selectMode ? (
          <>
            <button
              onClick={toggleSelectAll}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text)]"
            >
              {t('common.selectAll')}{allSelected ? ' ✓' : ''}
            </button>
            <button
              onClick={exitSelectMode}
              className="text-xs px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >{t('common.cancel')}</button>
          </>
        ) : (
          <>
            <button
              onClick={onNew}
              disabled={!assistantId}
              className="flex-1 text-xs px-2 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40"
            >
              {t('agent.newSession')}
            </button>
            {onBatchExport && (
              <ExportMenu
                triggerTitle={t('chat.exportBatch')}
                triggerContent="📤"
                triggerClassName="text-xs px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap disabled:opacity-40"
                items={[
                  { key: 'md', label: t('chat.exportBatchMd') },
                  { key: 'html', label: t('chat.exportBatchHtml') },
                  ...(onBatchExportSelected ? [{ key: 'multi', label: t('chat.exportMulti') }] : [])
                ]}
                onPick={(k) => {
                  if (k === 'multi') {
                    setSearch('')
                    setSelectedIds([])
                    setSelectMode(true)
                  } else {
                    onBatchExport(k as 'md' | 'html')
                  }
                }}
              />
            )}
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
          </>
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
            hasMore={hasMore}
            loadingMore={loadingMore}
            onSelectConv={handleSelectResult}
            onSelectMessage={handleSelectMessage}
            onLoadMore={loadMore}
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
                onExportHtml={onExportHtml ? () => onExportHtml(c.id) : undefined}
                onExportPdf={onExportPdf ? () => onExportPdf(c.id) : undefined}
                onExportEncrypted={onExportEncrypted ? () => onExportEncrypted(c.id) : undefined}
                onTogglePin={onTogglePin ? (pinned) => onTogglePin(c.id, pinned) : undefined}
                onSetArchived={onSetArchived ? (archived) => onSetArchived(c.id, archived) : undefined}
                selectMode={selectMode}
                checked={selectedIds.includes(c.id)}
                onToggleSelect={() => toggleSelect(c.id)}
              />
            ))}
            {!!archivedConversations?.length && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full flex items-center gap-1 px-1 py-1 rounded text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)]"
                >
                  <span className="text-[9px]">{showArchived ? '▼' : '▶'}</span>
                  <span>📦 {t('chat.archivedSection', { n: archivedConversations.length })}</span>
                </button>
                {showArchived && archivedConversations.map((c) => (
                  <SessionItem
                    key={c.id}
                    conv={c}
                    inArchive
                    isActive={conversationId === c.id}
                    onSelect={() => onSelect(c.id)}
                    onDelete={() => onDelete(c.id)}
                    onRename={(title) => onRename(c.id, title)}
                    onExport={onExport ? () => onExport(c.id) : undefined}
                    onExportHtml={onExportHtml ? () => onExportHtml(c.id) : undefined}
                    onExportPdf={onExportPdf ? () => onExportPdf(c.id) : undefined}
                    onExportEncrypted={onExportEncrypted ? () => onExportEncrypted(c.id) : undefined}
                    onSetArchived={onSetArchived ? (archived) => onSetArchived(c.id, archived) : undefined}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 多选操作条（selectMode 时固定底部；归档区不参与多选） */}
      {selectMode && (
        <div className="shrink-0 border-t border-[var(--color-border)] pt-2 mt-1 flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--color-text-muted)] flex-1 truncate">
            {t('chat.exportMultiCount', { n: selectedConvs.length })}
          </span>
          <button
            onClick={() => handleExportSelected('md')}
            disabled={selectedConvs.length === 0}
            className="text-[11px] px-2 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-40 whitespace-nowrap"
          >{t('chat.exportSelectedMd')}</button>
          <button
            onClick={() => handleExportSelected('html')}
            disabled={selectedConvs.length === 0}
            className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text)] disabled:opacity-40 whitespace-nowrap"
          >{t('chat.exportSelectedHtml')}</button>
          {onBatchExportSelected && (
            <button
              onClick={() => handleExportSelected('pdf')}
              disabled={selectedConvs.length === 0}
              className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text)] disabled:opacity-40 whitespace-nowrap"
            >{t('chat.exportSelectedPdf')}</button>
          )}
        </div>
      )}
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
  onExportHtml?: () => void
  onExportPdf?: () => void
  onExportEncrypted?: () => void
  onTogglePin?: (pinned: boolean) => void
  onSetArchived?: (archived: boolean) => void
  /** 多选模式：行首 checkbox，点击行=切换选中，隐藏操作按钮 */
  selectMode?: boolean
  checked?: boolean
  onToggleSelect?: () => void
  /** 归档区内的行：不显示置顶项、归档项文案改取消归档 */
  inArchive?: boolean
}> = ({ conv, isActive, onSelect, onDelete, onRename, onExport, onExportHtml, onExportPdf, onExportEncrypted, onTogglePin, onSetArchived, selectMode, checked, onToggleSelect, inArchive }) => {
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
  const rowActive = selectMode ? checked : isActive

  return (
    <div
      onClick={editing ? undefined : (selectMode && onToggleSelect ? onToggleSelect : onSelect)}
      onDoubleClick={() => !selectMode && setEditing(true)}
      className={`group flex items-center rounded text-xs ${
        editing ? '' : 'cursor-pointer ' + (rowActive
          ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
          : 'hover:bg-[var(--color-hover-overlay)]')
      }`}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={() => onToggleSelect?.()}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 ml-2 w-3.5 h-3.5 accent-[var(--color-accent)] cursor-pointer"
          aria-label={displayTitle}
        />
      )}
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
          <div className="truncate">
            {conv.pinned && !selectMode && <span className="mr-1 text-[9px] opacity-70" title={t('chat.unpin')}>📍</span>}
            {displayTitle}
          </div>
        </div>
      )}
      {!editing && !selectMode && (
        <>
          <ExportMenu
            triggerTitle={t('chat.more')}
            triggerContent="⋯"
            triggerClassName="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center text-sm leading-none text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            items={[
              ...(onTogglePin && !inArchive ? [{ key: 'pin', label: conv.pinned ? t('chat.unpin') : t('chat.pin') }] : []),
              ...(onSetArchived ? [{ key: 'archive', label: inArchive ? t('chat.unarchive') : t('chat.archive') }] : []),
              { key: 'rename', label: t('chat.rename') }
            ]}
            onPick={(k) => {
              if (k === 'pin') onTogglePin?.(!conv.pinned)
              else if (k === 'archive') onSetArchived?.(!inArchive)
              else if (k === 'rename') setEditing(true)
            }}
          />
          {(onExport || onExportHtml) && (
            <ExportMenu
              triggerTitle={t('chat.exportMenu')}
              triggerContent="↓"
              triggerClassName="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              items={[
                ...(onExport ? [{ key: 'md', label: t('chat.exportMd') }] : []),
                ...(onExportHtml ? [{ key: 'html', label: t('chat.exportHtml') }] : []),
                ...(onExportPdf ? [{ key: 'pdf', label: t('chat.exportPdf') }] : [])
              ]}
              onPick={(k) => (k === 'html' ? onExportHtml?.() : k === 'pdf' ? onExportPdf?.() : onExport?.())}
            />
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
