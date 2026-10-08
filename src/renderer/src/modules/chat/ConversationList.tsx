import React, { useState, useEffect, useRef, useMemo } from 'react'
import type { ConversationRecord, ConversationGroupRecord, MessageSearchResult, StarredMessageItem } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { EmptyState } from '../../components/EmptyState'
import { MessageSearchResults, relTime } from '../../components/MessageSearchResults'
import { logIpcError } from '../../utils/ipc'
import { formatDateTime } from '../../utils/time'

interface Props {
  conversations: ConversationRecord[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename?: (id: string, title: string) => void
  onExport?: (id: string) => void
  onExportHtml?: (id: string) => void
  onExportPdf?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onBatchExport?: (format: 'md' | 'html') => void
  /** 多选导出：把选中的会话（按列表显示顺序）交父级导出 */
  onBatchExportSelected?: (format: 'md' | 'html' | 'pdf', convs: ConversationRecord[]) => void
  /** 批量删除：选中会话 id 列表交父级执行 */
  onBatchDelete?: (ids: string[]) => void
  /** 归档区会话（底部折叠展示） */
  archivedConversations?: ConversationRecord[]
  onTogglePin?: (id: string, pinned: boolean) => void
  onSetArchived?: (id: string, archived: boolean) => void
  onImport?: () => void
  onImportEncrypted?: () => void
  /** 外部平台记录（ChatGPT/Claude）导入 */
  onImportExternal?: () => void
  /** 搜索结果点击：跳转定位到匹配消息（convId + messageId） */
  onSelectMessage?: (convId: string, messageId: string) => void
  /** 切换消息收藏星标（收藏列表内取消收藏复用） */
  onToggleStar?: (id: string, starred: boolean) => void
  /** 分组文件夹（当前助手维度；仅普通列表态分区，搜索/多选/过滤态平铺） */
  groups?: ConversationGroupRecord[]
  onCreateGroup?: (name: string) => Promise<boolean> | boolean
  onRenameGroup?: (id: string, name: string) => void
  onDeleteGroup?: (id: string) => void
  /** 拖拽/菜单移动会话到组；null=移出分组 */
  onMoveConv?: (convId: string, groupId: string | null) => void
  /** 备注编辑 */
  onSetNote?: (convId: string, note: string | null) => void
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
  onExportPdf,
  onExportEncrypted,
  onBatchExport,
  onBatchExportSelected,
  onBatchDelete,
  archivedConversations,
  onTogglePin,
  onSetArchived,
  onImport,
  onImportEncrypted,
  onImportExternal,
  onSelectMessage,
  onToggleStar,
  groups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveConv,
  onSetNote,
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
  const [showArchived, setShowArchived] = useState(false)
  // 多选导出模式：与搜索态互斥；选中集合用数组保序（导出按列表显示顺序）
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  // 会话标题过滤（纯前端，与消息搜索互斥）
  const [convFilter, setConvFilter] = useState('')
  // 收藏列表视图：与搜索/过滤/多选互斥；数据由本组件自持（上限 200 条）
  const [starredMode, setStarredMode] = useState(false)
  const [starredItems, setStarredItems] = useState<StarredMessageItem[]>([])
  const [starredLoading, setStarredLoading] = useState(false)
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

  const handleDeleteSelected = async () => {
    if (selectedConvs.length === 0 || deleting) return
    if (!window.confirm(t('chat.batchDeleteConfirm', { n: selectedConvs.length }))) return
    setDeleting(true)
    try {
      await onBatchDelete?.(selectedIds)
      exitSelectMode()
    } finally {
      setDeleting(false)
    }
  }

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

  // 会话标题过滤：不区分大小写匹配 title；空关键词不过滤
  const filteredConversations = convFilter.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(convFilter.trim().toLowerCase()))
    : conversations

  // ---------- 分组文件夹 ----------
  // 折叠态用「折叠集合」：默认全展开，只记录被手动折叠的组
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null) // '__none__'=未分组放置带
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupRenameDraft, setGroupRenameDraft] = useState('')
  const newGroupInputRef = useRef<HTMLInputElement>(null)
  const groupRenameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!creatingGroup) return
    const raf = requestAnimationFrame(() => newGroupInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [creatingGroup])
  useEffect(() => {
    if (!renamingGroupId) return
    const raf = requestAnimationFrame(() => { groupRenameRef.current?.focus(); groupRenameRef.current?.select() })
    return () => cancelAnimationFrame(raf)
  }, [renamingGroupId])

  /** 分区仅在普通浏览态生效（搜索/收藏/多选/标题过滤时平铺，便于全局查找） */
  const groupedMode = !isSearching && !starredMode && !selectMode && !convFilter.trim() && !!onMoveConv

  // 置顶优先，其次最近更新
  const convCmp = (a: ConversationRecord, b: ConversationRecord) =>
    Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt

  const topConversations = useMemo(
    () => (groupedMode ? filteredConversations.filter((c) => !c.groupId).sort(convCmp) : filteredConversations),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groupedMode, filteredConversations]
  )
  const groupViews = useMemo(() => {
    if (!groupedMode) return []
    const byGroup = new Map<string, ConversationRecord[]>()
    for (const c of filteredConversations) {
      if (!c.groupId) continue
      const arr = byGroup.get(c.groupId)
      if (arr) arr.push(c); else byGroup.set(c.groupId, [c])
    }
    return (groups ?? [])
      .map((g) => ({ group: g, convs: (byGroup.get(g.id) ?? []).slice().sort(convCmp) }))
      .filter((v) => v.convs.length > 0)
      // 组按组内最近会话排，最近用的在上；无 sort_order 维护
      .sort((a, b) => b.convs[0]!.updatedAt - a.convs[0]!.updatedAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedMode, filteredConversations, groups])

  // 当前会话所在组自动展开（切会话/移动后保持可见）
  useEffect(() => {
    if (!currentId || !groupedMode) return
    const cur = conversations.find((c) => c.id === currentId)
    if (cur?.groupId) {
      setCollapsedGroups((prev) => {
        if (!prev.has(cur.groupId!)) return prev
        const next = new Set(prev)
        next.delete(cur.groupId!)
        return next
      })
    }
  }, [currentId, conversations, groupedMode])

  const toggleGroupCollapse = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const submitCreateGroup = async () => {
    const name = newGroupName.trim()
    if (!name || !onCreateGroup) { setCreatingGroup(false); return }
    const ok = await onCreateGroup(name)
    if (ok) { setCreatingGroup(false); setNewGroupName('') }
  }

  const submitRenameGroup = async () => {
    const name = groupRenameDraft.trim()
    if (renamingGroupId && name && onRenameGroup) await onRenameGroup(renamingGroupId, name)
    setRenamingGroupId(null)
  }

  /** 拖拽 DnD：会话行 → 文件夹头/未分组带（原生 dataTransfer，同 Sidebar 模式） */
  const onGroupDrop = (e: React.DragEvent, groupId: string | null) => {
    e.preventDefault()
    const convId = e.dataTransfer.getData('application/x-pocketai-conv')
    setDragOverGroup(null)
    if (convId && onMoveConv) {
      const cur = conversations.find((c) => c.id === convId)
      if ((cur?.groupId ?? null) !== groupId) onMoveConv(convId, groupId)
    }
  }

  /** 渲染单个会话行：indented=文件夹内缩进；普通浏览态可拖拽入组（多选/归档不拖） */
  const renderConv = (c: ConversationRecord, indented: boolean) => (
    <ConvItem
      key={c.id}
      conv={c}
      indented={indented}
      isActive={currentId === c.id}
      onSelect={() => onSelect(c.id)}
      onDelete={() => onDelete(c.id)}
      onRename={onRename ? (title) => onRename(c.id, title) : undefined}
      onExport={onExport}
      onExportHtml={onExportHtml}
      onExportPdf={onExportPdf}
      onExportEncrypted={onExportEncrypted}
      onTogglePin={onTogglePin}
      onSetArchived={onSetArchived}
      selectMode={selectMode}
      checked={selectedIds.includes(c.id)}
      onToggleSelect={() => toggleSelect(c.id)}
      groups={groups}
      onMoveConv={groupedMode ? onMoveConv : undefined}
      onSetNote={onSetNote}
      draggable={groupedMode && !selectMode}
    />
  )

  // 收藏列表：进入时拉取一次（上限 200）；退出清空状态回会话列表
  const loadStarred = async () => {
    setStarredLoading(true)
    try {
      setStarredItems(await window.pocketai.listStarredMessages(200))
    } catch (e) {
      logIpcError('chat.listStarredMessages', e)
      setStarredItems([])
    } finally {
      setStarredLoading(false)
    }
  }

  const toggleStarredMode = () => {
    if (starredMode) {
      setStarredMode(false)
      return
    }
    // 模式互斥：清搜索/过滤/多选（与导出处同手法）
    setSearch('')
    setConvFilter('')
    setSelectedIds([])
    setSelectMode(false)
    setStarredMode(true)
    void loadStarred()
  }

  // 收藏列表内取消收藏：上行通知父级同步气泡状态，本地从列表移除
  const handleUnstar = (id: string) => {
    onToggleStar?.(id, false)
    setStarredItems((prev) => prev.filter((m) => m.id !== id))
  }

  return (
    <div className={embedded ? 'flex flex-col h-full min-h-0' : 'w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)]'}>
      {/* 搜索框（收藏视图态隐藏） */}
      <div className="p-2 space-y-2">
        {!starredMode && (
        <div className="relative">
          <input
            data-chat-search-input
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
        )}
        {/* 会话标题过滤（仅非消息搜索态且非多选态且非收藏态显示） */}
        {!isSearching && !selectMode && !starredMode && (
          <div className="relative">
            <input
              className="input text-xs pl-7"
              placeholder={t('chat.filterConversations')}
              value={convFilter}
              onChange={(e) => setConvFilter(e.target.value)}
            />
            {convFilter && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-xs"
                onClick={() => setConvFilter('')}
              >×</button>
            )}
          </div>
        )}
        {/* 工具栏两行布局：主行（新对话+批量导出）/ 次行（导入·加密导入·收藏·建组），
            避免单行塞 6 个 nowrap 按钮溢出窄栏（flex-1 被压扁致文字竖排） */}
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            {selectMode ? (
              <>
                <button
                  onClick={toggleSelectAll}
                  className="flex-1 text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text)]"
                >
                  {t('common.selectAll')}{allSelected ? ' ✓' : ''}
                </button>
                <button
                  onClick={exitSelectMode}
                  className="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >{t('common.cancel')}</button>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
          {!selectMode && (
            <div className="flex gap-1 flex-wrap">
              {onImport && (
                <button
                  onClick={onImport}
                  className="flex-1 text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
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
              {onImportExternal && (
                <button
                  onClick={onImportExternal}
                  className="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
                  title={t('chat.importExternal')}
                >🌐 {t('chat.importExternalShort')}</button>
              )}
              {onToggleStar && (
                <button
                  onClick={toggleStarredMode}
                  className={`text-xs px-2 py-2 rounded border whitespace-nowrap ${starredMode ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]'}`}
                  title={t('chat.starredList')}
                  aria-pressed={starredMode}
                >⭐</button>
              )}
              {onCreateGroup && !isSearching && (
                <button
                  onClick={() => { setCreatingGroup(true); setNewGroupName('') }}
                  className="text-xs px-2 py-2 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] whitespace-nowrap"
                  title={t('chat.groupNew')}
                  aria-label={t('chat.groupNew')}
                >📁＋</button>
              )}
            </div>
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

      {/* 收藏列表 / 搜索结果区 / 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {starredMode ? (
          <StarredResults
            items={starredItems}
            loading={starredLoading}
            onSelectMessage={(convId, msgId) => {
              onSelectMessage ? onSelectMessage(convId, msgId) : onSelect(convId)
            }}
            onUnstar={handleUnstar}
          />
        ) : isSearching ? (
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
          <>
            {/* 新建文件夹内联输入行 */}
            {creatingGroup && (
              <div className="flex items-center gap-1 px-2 py-1.5 mb-0.5 rounded bg-[var(--color-hover-overlay)]">
                <span className="text-xs">📁</span>
                <input
                  ref={newGroupInputRef}
                  className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                  placeholder={t('chat.groupNamePh')}
                  value={newGroupName}
                  maxLength={40}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitCreateGroup()
                    if (e.key === 'Escape') { setCreatingGroup(false); setNewGroupName('') }
                  }}
                  onBlur={() => { if (!newGroupName.trim()) setCreatingGroup(false) }}
                />
              </div>
            )}

            {groupedMode ? (
              <>
                {topConversations.length === 0 && groupViews.length === 0 && (
                  <EmptyState
                    className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2"
                    message={t('chat.noConversations')}
                  />
                )}
                {/* 未分组区标题：同时是拖出文件夹的放置目标；无任何组时不占位 */}
                {groupViews.length > 0 && (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOverGroup('__none__') }}
                    onDragLeave={() => setDragOverGroup(null)}
                    onDrop={(e) => onGroupDrop(e, null)}
                    className={`px-2.5 py-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] rounded ${dragOverGroup === '__none__' ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : ''}`}
                  >
                    {t('chat.groupUngrouped')}
                  </div>
                )}
                {topConversations.map((c) => renderConv(c, false))}

                {groupViews.map(({ group, convs }) => {
                  const collapsed = collapsedGroups.has(group.id)
                  const renaming = renamingGroupId === group.id
                  return (
                    <div key={group.id} className="pt-0.5">
                      {renaming ? (
                        <div className="flex items-center gap-1 px-2 py-1">
                          <span className="text-xs">📁</span>
                          <input
                            ref={groupRenameRef}
                            className="flex-1 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-1.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                            value={groupRenameDraft}
                            maxLength={40}
                            onChange={(e) => setGroupRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void submitRenameGroup()
                              if (e.key === 'Escape') setRenamingGroupId(null)
                            }}
                            onBlur={() => void submitRenameGroup()}
                          />
                        </div>
                      ) : (
                        <div
                          onClick={() => toggleGroupCollapse(group.id)}
                          onDragOver={(e) => { e.preventDefault(); setDragOverGroup(group.id) }}
                          onDragLeave={() => setDragOverGroup(null)}
                          onDrop={(e) => onGroupDrop(e, group.id)}
                          className={`group/folder flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium cursor-pointer select-none ${
                            dragOverGroup === group.id
                              ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                              : 'hover:bg-[var(--color-hover-overlay)]'
                          } text-[var(--color-text)]`}
                          title={t('chat.groupDropHint')}
                        >
                          <span className="text-[10px] w-3 text-[var(--color-text-muted)]">{collapsed ? '▶' : '▼'}</span>
                          <span>{collapsed ? '📁' : '📂'}</span>
                          <span className="flex-1 truncate">{group.name}</span>
                          <span className="text-[10px] text-[var(--color-text-muted)]">{convs.length}</span>
                          <span className="hidden group-hover/folder:flex items-center gap-1">
                            <button
                              type="button"
                              className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                              title={t('chat.groupRename')}
                              onClick={(e) => {
                                e.stopPropagation()
                                setGroupRenameDraft(group.name)
                                setRenamingGroupId(group.id)
                              }}
                            >✏️</button>
                            <button
                              type="button"
                              className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                              title={t('chat.groupDelete')}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (window.confirm(t('chat.groupDeleteConfirm', { name: group.name }))) {
                                  onDeleteGroup?.(group.id)
                                }
                              }}
                            >🗑</button>
                          </span>
                        </div>
                      )}
                      {!collapsed && !renaming && convs.map((c) => renderConv(c, true))}
                    </div>
                  )
                })}
              </>
            ) : (
              <>
                {filteredConversations.length === 0 && (
                  <EmptyState
                    className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2"
                    message={convFilter.trim() ? t('chat.noFilteredConversations') : t('chat.noConversations')}
                  />
                )}
                {filteredConversations.map((c) => renderConv(c, false))}
              </>
            )}
            {!!archivedConversations?.length && (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="w-full flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)]"
                >
                  <span className="text-[10px]">{showArchived ? '▼' : '▶'}</span>
                  <span>📦 {t('chat.archivedSection', { n: archivedConversations.length })}</span>
                </button>
                {showArchived && archivedConversations.map((c) => (
                  <ConvItem
                    key={c.id}
                    conv={c}
                    inArchive
                    isActive={currentId === c.id}
                    onSelect={() => onSelect(c.id)}
                    onDelete={() => onDelete(c.id)}
                    onRename={onRename ? (title) => onRename(c.id, title) : undefined}
                    onExport={onExport}
                    onExportHtml={onExportHtml}
                    onExportPdf={onExportPdf}
                    onExportEncrypted={onExportEncrypted}
                    onSetArchived={onSetArchived}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 多选操作条（selectMode 时固定底部；归档区不参与多选） */}
      {selectMode && (
        <div className="shrink-0 border-t border-[var(--color-border)] px-2 py-2 flex items-center gap-1.5 bg-[var(--color-sidebar)]">
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
          {onBatchDelete && (
            <button
              onClick={handleDeleteSelected}
              disabled={selectedConvs.length === 0 || deleting}
              className="text-[11px] px-2 py-1.5 rounded border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] disabled:opacity-40 whitespace-nowrap"
            >{deleting ? t('common.deleting') : t('chat.batchDelete')}</button>
          )}
        </div>
      )}
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
  onExportPdf?: (id: string) => void
  onExportEncrypted?: (id: string) => void
  onTogglePin?: (id: string, pinned: boolean) => void
  onSetArchived?: (id: string, archived: boolean) => void
  /** 多选模式：行首 checkbox，点击行=切换选中，隐藏操作按钮 */
  selectMode?: boolean
  checked?: boolean
  onToggleSelect?: () => void
  /** 归档区内的行：菜单不显示置顶项、归档项文案改取消归档 */
  inArchive?: boolean
  /** 文件夹内的行：左侧缩进 */
  indented?: boolean
  /** 可拖拽到文件夹（仅活跃区普通态） */
  draggable?: boolean
  /** 文件夹菜单项 + 移动回调；不给则不显示「移入分组」菜单 */
  groups?: ConversationGroupRecord[]
  onMoveConv?: (convId: string, groupId: string | null) => void
  /** 备注编辑回调；不给则不显示备注菜单项 */
  onSetNote?: (convId: string, note: string | null) => void
}> = ({ conv, isActive, onSelect, onDelete, onRename, onExport, onExportHtml, onExportPdf, onExportEncrypted, onTogglePin, onSetArchived, selectMode, checked, onToggleSelect, inArchive, indented, draggable, groups, onMoveConv, onSetNote }) => {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const inputRef = useRef<HTMLInputElement>(null)
  // 备注行内编辑态
  const [noteEditing, setNoteEditing] = useState(false)
  const [noteDraft, setNoteDraft] = useState(conv.note ?? '')
  const noteInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    if (!noteEditing) return
    setNoteDraft(conv.note ?? '')
    let rafId: number
    rafId = requestAnimationFrame(() => noteInputRef.current?.focus())
    return () => cancelAnimationFrame(rafId)
  }, [noteEditing, conv.note])

  const commitNote = () => {
    const v = noteDraft.trim()
    if (v !== (conv.note ?? '')) onSetNote?.(conv.id, v || null)
    setNoteEditing(false)
  }

  const rowActive = selectMode ? checked : isActive

  return (
    <div
      onClick={editing || noteEditing ? undefined : (selectMode && onToggleSelect ? onToggleSelect : onSelect)}
      onDoubleClick={() => onRename && !selectMode && setEditing(true)}
      draggable={draggable && !editing && !selectMode}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-pocketai-conv', conv.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={`group flex items-center gap-1 px-2.5 py-2 rounded text-sm ${indented ? 'ml-3' : ''} ${
        editing ? '' : 'cursor-pointer ' + (rowActive
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
          : 'hover:bg-[var(--color-hover-overlay)] text-[var(--color-text)]')
      } ${draggable && !editing ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      {selectMode && (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={() => onToggleSelect?.()}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 w-3.5 h-3.5 accent-[var(--color-accent)] cursor-pointer"
          aria-label={conv.title}
        />
      )}
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
        <div className="flex-1 min-w-0">
          <span className="block truncate">
            {conv.pinned && !selectMode && <span className="mr-1 text-[10px] opacity-70" title={t('chat.unpin')}>📍</span>}
            {!selectMode && conv.hasDraft && <span className="mr-1 text-[10px]" title={t('chat.draftHint')}>📝</span>}
            {conv.title}
          </span>
          {/* 最新消息预览：多选态/空预览不渲染，避免行高跳动 */}
          {!selectMode && conv.lastMessagePreview && (
            <span className="block truncate text-[11px] leading-4 text-[var(--color-text-muted)]">{conv.lastMessagePreview}</span>
          )}
          {/* 备注：编辑态显示 input，否则有备注时显示一行 */}
          {!selectMode && noteEditing ? (
            <input
              ref={noteInputRef}
              className="block w-full mt-0.5 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded px-1 py-0.5 text-[10px] outline-none focus:border-[var(--color-accent)]"
              value={noteDraft}
              placeholder={t('chat.notePh')}
              maxLength={200}
              onChange={(e) => setNoteDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitNote}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNote()
                if (e.key === 'Escape') setNoteEditing(false)
              }}
            />
          ) : (!selectMode && conv.note ? (
            <span className="block truncate text-[10px] leading-4 text-[var(--color-text-muted)] opacity-80" title={conv.note}>📝 {conv.note}</span>
          ) : null)}
        </div>
      )}
      {/* 最后活跃相对时间：非编辑/非多选态显示，避免布局挤压 */}
      {!editing && !selectMode && (
        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] opacity-70 ml-1" title={formatDateTime(conv.updatedAt)}>
          {relTime(conv.updatedAt, t)}
        </span>
      )}
      {(onTogglePin || onSetArchived || onRename || onMoveConv || onSetNote) && !editing && !noteEditing && !selectMode && (
        <ExportMenu
          triggerTitle={t('chat.more')}
          triggerContent="⋯"
          triggerClassName="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-sm leading-none"
          items={[
            ...(onTogglePin && !inArchive ? [{ key: 'pin', label: conv.pinned ? t('chat.unpin') : t('chat.pin') }] : []),
            ...(onSetArchived ? [{ key: 'archive', label: inArchive ? t('chat.unarchive') : t('chat.archive') }] : []),
            ...(onRename ? [{ key: 'rename', label: t('chat.rename') }] : []),
            ...(onSetNote ? [{ key: 'note', label: t('chat.noteEdit') }] : []),
            // 移入分组（当前所在组加 ✓）；已在组中则补「移出文件夹」
            ...(onMoveConv && groups
              ? groups.map((g) => ({ key: `grp:${g.id}`, label: `${conv.groupId === g.id ? '✓ ' : ''}📁 ${g.name}` }))
              : []),
            ...(onMoveConv && conv.groupId ? [{ key: 'grp-out', label: `📂 ${t('chat.groupMoveOut')}` }] : [])
          ]}
          onPick={(k) => {
            if (k === 'pin') onTogglePin?.(conv.id, !conv.pinned)
            else if (k === 'archive') onSetArchived?.(conv.id, !inArchive)
            else if (k === 'rename') setEditing(true)
            else if (k === 'note') setNoteEditing(true)
            else if (k === 'grp-out') onMoveConv?.(conv.id, null)
            else if (k.startsWith('grp:')) onMoveConv?.(conv.id, k.slice(4))
          }}
        />
      )}
      {(onExport || onExportHtml) && !editing && !selectMode && (
        <ExportMenu
          triggerTitle={t('chat.exportMenu')}
          triggerContent="↓"
          triggerClassName="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          items={[
            ...(onExport ? [{ key: 'md', label: t('chat.exportMd') }] : []),
            ...(onExportHtml ? [{ key: 'html', label: t('chat.exportHtml') }] : []),
            ...(onExportPdf ? [{ key: 'pdf', label: t('chat.exportPdf') }] : [])
          ]}
          onPick={(k) => (k === 'html' ? onExportHtml?.(conv.id) : k === 'pdf' ? onExportPdf?.(conv.id) : onExport?.(conv.id))}
        />
      )}
      {onExportEncrypted && !editing && !selectMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onExportEncrypted(conv.id) }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.exportEncrypted')}
          aria-label={t('chat.exportEncrypted')}
        >🔐</button>
      )}
      {!selectMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] w-4 h-4 flex items-center justify-center text-xs"
          title={t('chat.delete')}
          aria-label={t('chat.delete')}
        >×</button>
      )}
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

/** 收藏列表视图：跨会话统一查看 starred 消息；点击跳转定位（复用搜索跳转链路），行尾可取消收藏 */
const StarredResults: React.FC<{
  items: StarredMessageItem[]
  loading: boolean
  onSelectMessage: (convId: string, messageId: string) => void
  onUnstar: (id: string) => void
}> = ({ items, loading, onSelectMessage, onUnstar }) => {
  const { t } = useI18n()
  if (loading) {
    return <EmptyState className="text-xs text-[var(--color-text-muted)] text-center mt-6" message={t('chat.searching')} />
  }
  if (items.length === 0) {
    return <EmptyState className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2" message={t('chat.starredEmpty')} />
  }
  return (
    <>
      <p className="text-[11px] text-[var(--color-text-muted)] px-1 py-1">{t('chat.starredList')} · {items.length}</p>
      {items.map((m) => (
        <div
          key={m.id}
          onClick={() => onSelectMessage(m.conversationId, m.id)}
          className="group text-[11px] px-2.5 py-1.5 rounded cursor-pointer hover:bg-[var(--color-hover-overlay)] border border-transparent hover:border-[var(--color-border)]"
        >
          <div className="flex items-center gap-1 mb-0.5">
            <span className={`inline-block ${m.role === 'user' ? 'text-[var(--color-info)]' : 'text-[var(--color-success)]'}`}>
              {m.role === 'user' ? t('chat.roleYou') : t('chat.roleAI')}
            </span>
            <span className="text-[var(--color-text-muted)] truncate flex-1" title={m.conversationTitle}>
              {m.conversationTitle ? `· ${m.conversationTitle}` : ''}
            </span>
            <span className="text-[var(--color-text-muted)] opacity-60 shrink-0">· {relTime(m.createdAt, t)}</span>
            <button
              type="button"
              title={t('chat.unstar')}
              aria-label={t('chat.unstar')}
              className="opacity-0 group-hover:opacity-100 shrink-0 px-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              onClick={(e) => { e.stopPropagation(); onUnstar(m.id) }}
            >☆</button>
          </div>
          <p className="text-[var(--color-text)] leading-snug line-clamp-2">
            {m.content.replace(/\s+/g, ' ').trim()}
          </p>
        </div>
      ))}
    </>
  )
}

