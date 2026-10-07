// Agent 对话面板：左侧会话栏（可收起） + 右侧配置栏/消息流/输入区（纯组合，逻辑都在 hooks 中）
import React, { useEffect, useRef, useState } from 'react'
import type { ConversationRecord } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { useProviderData } from '../hooks/useProviderData'
import { useAgentChat } from '../hooks/useAgentChat'
import { APP_SHORTCUT_EVENT, isActiveModuleInstance, type AppShortcutEventDetail } from '../../../hooks/useGlobalShortcuts'
import { useAgentToolConfigs } from '../hooks/useAgentToolConfigs'
import { useAttachments } from '../hooks/useAttachments'
import { SessionRail } from '../components/SessionRail'
import { AgentModelBar } from '../components/AgentModelBar'
import { AgentToolBars } from '../components/AgentToolBars'
import { AgentComposer } from '../components/AgentComposer'
import { VirtualMessageList } from '../components/VirtualMessageList'
import { AgentSearchBar } from '../components/AgentSearchBar'
import { formatRunDuration, agentMessagesToMarkdown, searchAgentMessages } from '../agent-shared'
import { useToast } from '../../../components/ToastProvider'
import { useAppStore } from '../../../store/app-store'
import { errText } from '../../../utils/error'
import { writeClipboard } from '../../../utils/clipboard'
import { buildConversationHtml } from '../../../utils/export-html'
import { buildReminderText } from '../../../utils/reminder-presets'
import { formatDateTime } from '../../../utils/time'
import { capSelection, buildBatchExportFiles, finishBatchExport, BATCH_EXPORT_MAX, BATCH_PDF_MAX } from '../../../utils/batch-export'

export const AgentPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const { providers, assistants, fetchingModels, fetchModels } = useProviderData()
  const chat = useAgentChat(providers)
  // busy 上报：Agent 运行中豁免休眠，防止切走标签后被 LRU 卸载导致任务中断
  useEffect(() => {
    useAppStore.getState().setModuleBusy('agent', chat.running)
  }, [chat.running])
  const tools = useAgentToolConfigs()
  const att = useAttachments()
  const [railOpen, setRailOpen] = useState(true)
  const [statsExpanded, setStatsExpanded] = useState(false)

  // ---------- 会话内消息搜索 ----------
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(0)
  const searchHits = React.useMemo(
    () => (searchOpen ? searchAgentMessages(chat.messages, searchQuery) : []),
    [searchOpen, chat.messages, searchQuery]
  )
  // 命中集合变化（查询词/消息变化）时把当前命中收回到合法范围
  useEffect(() => {
    setSearchActive((i) => (searchHits.length === 0 ? 0 : Math.min(i, searchHits.length - 1)))
  }, [searchHits])
  // 切会话时关闭搜索
  useEffect(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchActive(0)
  }, [chat.conversationId])

  const openSearch = () => {
    setSearchOpen(true)
    setSearchQuery('')
    setSearchActive(0)
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchActive(0)
  }
  const gotoPrevHit = () => {
    if (searchHits.length === 0) return
    setSearchActive((i) => (i - 1 + searchHits.length) % searchHits.length)
  }
  const gotoNextHit = () => {
    if (searchHits.length === 0) return
    setSearchActive((i) => (i + 1) % searchHits.length)
  }
  const activeHit = searchHits[searchActive] ?? null

  // 切换会话后收起分步明细（明细数据由 hook 在切会话时清空，展开态同步复位）
  useEffect(() => { setStatsExpanded(false) }, [chat.conversationId])

  // 消息右键「提醒我」：正文截取 200 字，带会话 id 落库；到点由系统通知（与 Chat 同链路）
  const handleRemind = async (messageId: string, fireAt: number) => {
    const msg = chat.messages.find((m) => m.id === messageId)
    const text = msg ? buildReminderText(msg.text ?? '') : ''
    if (!text) {
      toast.error(t('reminder.menu.emptyText'))
      return
    }
    try {
      await window.pocketai.createReminder({ text, fireAt, conversationId: chat.conversationId ?? null })
      toast.success(t('reminder.menu.created', { time: formatDateTime(fireAt) }))
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const toggleStats = () => {
    const next = !statsExpanded
    setStatsExpanded(next)
    if (next && chat.latestTraces === null) chat.loadLatestTraces()
  }

  const handleCopyTraces = async () => {
    if (!chat.latestTraces || chat.latestTraces.length === 0) return
    const ok = await writeClipboard(JSON.stringify(chat.latestTraces, null, 2))
    if (ok) toast.success(t('agent.traceCopied'))
    else toast.error(t('agent.copyFailed'))
  }

  // 当前会话标题（用于复制 Markdown 的一级标题）
  const currentTitle =
    chat.conversations.find((c) => c.id === chat.conversationId)?.title?.trim() ||
    t('agent.copyMdDefaultTitle')
  const hasMessages = chat.messages.length > 0

  // 应用内快捷键（中枢派发）：Ctrl+N 新建 / Ctrl+K 搜索 / Ctrl+/ 聚焦输入框 / Esc 停止
  // 仅活动 agent 实例响应（保活隐藏实例 / 同模块非活动实例由 data-active-module 守卫拦截）
  const shortcutRef = useRef({
    searchEnabled: false,
    searchOpen: false,
    newConv: () => {},
    openSearch: () => {},
    abort: () => {}
  })
  shortcutRef.current = {
    searchEnabled: hasMessages,
    searchOpen,
    newConv: () => void chat.newConversation(),
    openSearch,
    abort: chat.abort
  }
  useEffect(() => {
    const onShortcut = (ev: Event) => {
      if (!isActiveModuleInstance('agent')) return
      const { action } = (ev as CustomEvent<AppShortcutEventDetail>).detail
      const r = shortcutRef.current
      if (action === 'newConv') {
        r.newConv()
      } else if (action === 'focusSearch') {
        if (!r.searchEnabled) return // 与头部搜索按钮 disabled 对齐：无消息时不可用
        if (!r.searchOpen) r.openSearch()
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[data-agent-search-input]')?.focus()
        })
      } else if (action === 'focusComposer') {
        document.querySelector<HTMLTextAreaElement>('[data-agent-composer-input]')?.focus()
      } else if (action === 'abort') {
        r.abort()
      }
    }
    window.addEventListener(APP_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(APP_SHORTCUT_EVENT, onShortcut)
  }, [])

  // 头部快捷：导出 .md（复用会话栏同一通道）
  const handleExportCurrent = () => {
    if (chat.conversationId) void handleExportMd(chat.conversationId)
  }

  // 头部快捷：一键复制全文为 Markdown（内存消息，含工具步骤）
  const handleCopyAsMarkdown = async () => {
    const md = agentMessagesToMarkdown(chat.messages, currentTitle)
    const ok = await writeClipboard(md)
    if (ok) toast.success(t('agent.copyMdOk'))
    else toast.error(t('agent.copyFailed'))
  }

  // ---------- 会话导入/导出（对齐 Chat 模块）：Markdown 直接导出，加密导出/导入先弹密码框 ----------
  const [cryptoPrompt, setCryptoPrompt] = useState<null | { kind: 'export'; id: string } | { kind: 'import' }>(null)
  const [cryptoPwd, setCryptoPwd] = useState('')

  const handleExportMd = async (id: string) => {
    const r = await window.pocketai.exportConversationMd(id)
    if (r.canceled) return
    if (!r.ok) {
      toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
      return
    }
    if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
  }

  // HTML 导出：渲染端生成自包含 HTML，主进程存盘
  const handleExportHtml = async (id: string) => {
    try {
      const conv = chat.conversations.find((c) => c.id === id)
      if (!conv) {
        toast.error(t('chat.exportFail', { e: t('common.unknownError') }))
        return
      }
      const msgs = await window.pocketai.listMessages(id)
      const assistantName = chat.assistantId
        ? assistants.find((a) => a.id === chat.assistantId)?.name ?? null
        : null
      const html = await buildConversationHtml(conv, msgs, assistantName)
      const r = await window.pocketai.exportConversationHtml(id, html)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // PDF 导出：同一自包含 HTML 交给主进程隐藏窗口 printToPDF（见 main/export/pdf.ts）
  const handleExportPdf = async (id: string) => {
    try {
      const conv = chat.conversations.find((c) => c.id === id)
      if (!conv) {
        toast.error(t('chat.exportFail', { e: t('common.unknownError') }))
        return
      }
      const msgs = await window.pocketai.listMessages(id)
      const assistantName = chat.assistantId
        ? assistants.find((a) => a.id === chat.assistantId)?.name ?? null
        : null
      const html = await buildConversationHtml(conv, msgs, assistantName)
      const r = await window.pocketai.exportConversationPdf(id, html)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // 批量导出：convs 缺省 = 当前助手全部会话（列表即范围）；传入 = 多选导出
  // pdf 逐会话 printToPDF 耗时高，选中上限收紧为 BATCH_PDF_MAX
  const handleBatchExport = async (format: 'md' | 'html' | 'pdf', convs?: ConversationRecord[]) => {
    const list = convs ?? chat.conversations
    if (list.length === 0) {
      toast.info(t('chat.exportBatchEmpty'))
      return
    }
    try {
      const max = format === 'pdf' ? BATCH_PDF_MAX : BATCH_EXPORT_MAX
      let selected = list
      if (convs) {
        const capped = capSelection(convs, max)
        selected = capped.list
        if (capped.dropped > 0) {
          toast.info(t('chat.exportMultiCapped', { max, dropped: capped.dropped }))
        }
      }
      const assistantName = chat.assistantId
        ? assistants.find((a) => a.id === chat.assistantId)?.name ?? null
        : null
      const files = await buildBatchExportFiles({
        convs: selected,
        format,
        listMessages: (id) => window.pocketai.listMessages(id),
        resolveAssistantName: () => assistantName
      })
      const outcome = await finishBatchExport(files, format)
      if (outcome.kind === 'failed') {
        toast.error(t('chat.exportFail', { e: outcome.error || t('common.unknownError') }))
      } else if (outcome.kind === 'done') {
        const warn = outcome.failedCount > 0 ? `（${outcome.failedCount} ${t('chat.exportBatchFailed')}）` : ''
        toast.success(`${t('chat.exportBatchDone', { n: outcome.count, dir: outcome.dir })}${warn}`)
      }
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // 置顶/归档（归档仅列表层面隐藏，不影响当前查看；提示可在归档区找回）
  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      await chat.toggleConversationPinned(id, pinned)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  const handleSetArchived = async (id: string, archived: boolean) => {
    try {
      await chat.setConversationArchivedState(id, archived)
      if (archived) toast.info(t('chat.archivedHint'))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // JSON 明文导入：选择文件 → 解析 → IPC 入库 → 刷新当前助手会话列表
  const handleImportJson = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const payload = JSON.parse(await file.text())
        const r = await window.pocketai.importConversation(payload)
        if (!r.ok) {
          toast.error(t('chat.importFail', { e: r.error ?? t('common.unknownError') }))
          return
        }
        toast.success(t('chat.importOk', { n: r.messageCount ?? 0 }))
        await chat.reloadConversations()
      } catch (e) {
        toast.error(t('chat.importFail', { e: errText(e) }))
      }
    }
    input.click()
  }

  const confirmCrypto = async () => {
    if (!cryptoPrompt) return
    const prompt = cryptoPrompt
    const password = cryptoPwd
    setCryptoPrompt(null)
    setCryptoPwd('')
    if (prompt.kind === 'export') {
      const r = await window.pocketai.exportConversationEncrypted(prompt.id, password)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      toast.success(t('chat.exportSuccess', { path: r.path ?? '' }))
    } else {
      const r = await window.pocketai.importConversationEncrypted(password)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.importFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      toast.success(t('chat.importOk', { n: r.messageCount ?? 0 }))
      await chat.reloadConversations()
    }
  }

  return (
    <div className="flex gap-3 h-full">
      {railOpen && (
        <SessionRail
          assistants={assistants}
          assistantId={chat.assistantId}
          onAssistantChange={chat.setAssistantId}
          conversations={chat.conversations}
          conversationId={chat.conversationId}
          onSelect={chat.selectConversation}
          onNew={() => void chat.newConversation()}
          onDelete={(id) => void chat.deleteConversation(id)}
          onRename={(id, title) => void chat.renameConversation(id, title)}
          onExport={(id) => void handleExportMd(id)}
          onExportHtml={(id) => void handleExportHtml(id)}
          onExportPdf={(id) => void handleExportPdf(id)}
          onBatchExport={(fmt) => void handleBatchExport(fmt)}
          onBatchExportSelected={(fmt, convs) => void handleBatchExport(fmt, convs)}
          onExportEncrypted={(id) => { setCryptoPwd(''); setCryptoPrompt({ kind: 'export', id }) }}
          archivedConversations={chat.archivedConversations}
          onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
          onSetArchived={(id, archived) => void handleSetArchived(id, archived)}
          onImport={handleImportJson}
          onImportEncrypted={() => { setCryptoPwd(''); setCryptoPrompt({ kind: 'import' }) }}
        />
      )}

      {/* 右：对话区 */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-start gap-1">
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="shrink-0 mt-0.5 w-5 h-6 flex items-center justify-center text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] rounded"
            title={t('agent.toggleRail')}
            aria-label={t('agent.toggleRail')}
          >
            {railOpen ? '◀' : '▶'}
          </button>
          <div className="flex-1 min-w-0">
            <AgentModelBar
              providers={providers}
              providerId={chat.providerId}
              model={chat.model}
              onProviderChange={chat.changeProvider}
              onModelChange={chat.setModel}
              selectedProvider={chat.selectedProvider}
              fetchingModels={fetchingModels}
              onFetchModels={() => void fetchModels(chat.providerId)}
              workspaceDir={tools.workspaceDir}
              onPickWorkspace={() => void tools.pickWorkspace()}
            />
          </div>
          {/* 头部快捷：会话内搜索 */}
          <button
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
            disabled={!hasMessages}
            title={`${t('agent.search')} (Ctrl+K)`}
            aria-label={t('agent.search')}
            aria-pressed={searchOpen}
            className={`shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
              searchOpen
                ? 'bg-[var(--color-hover-overlay)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          {/* 头部快捷：复制全文 Markdown / 导出 .md 文件（侧栏收起时也可用） */}
          <button
            onClick={() => void handleCopyAsMarkdown()}
            disabled={!hasMessages}
            title={t('agent.copyAsMd')}
            aria-label={t('agent.copyAsMd')}
            className="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            onClick={handleExportCurrent}
            disabled={!hasMessages}
            title={t('agent.exportCurrent')}
            aria-label={t('agent.exportCurrent')}
            className="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>

        <AgentToolBars tools={tools} />

        {/* 会话内消息搜索栏 */}
        {searchOpen && (
          <AgentSearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            activeHit={searchActive}
            hitCount={searchHits.length}
            onPrev={gotoPrevHit}
            onNext={gotoNextHit}
            onClose={closeSearch}
          />
        )}

        {/* 消息流（虚拟化：只渲染可视区，避免长对话 DOM 线性增长） */}
        <VirtualMessageList
          messages={chat.messages}
          running={chat.running}
          conversationId={chat.conversationId}
          emptyHint={t('agent.emptyHint')}
          onDeleteMessage={chat.running ? undefined : (id) => void chat.deleteMessage(id)}
          onRerunMessage={chat.running ? undefined : (id, text) => void chat.rerun(id, text)}
          onRegenerateMessage={chat.running ? undefined : (id) => chat.regenerate(id)}
          onRemindMessage={chat.running ? undefined : (id, fireAt) => void handleRemind(id, fireAt)}
          focusIndex={activeHit?.index ?? null}
          highlightId={activeHit?.id ?? null}
        />

        {/* 运行中：实时步骤条（chip 流，step 事件驱动；结束后由 runStats 区接管） */}
        {chat.running && (
          <div className="mb-2 self-start w-full max-w-[640px] flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <span className="inline-block w-2 h-2 shrink-0 rounded-full bg-[var(--color-accent)] animate-pulse" />
            <span className="shrink-0">{t('agent.runningStep', { n: chat.currentStep })}</span>
            {chat.liveSteps.length > 0 && (
              <div className="flex-1 min-w-0 overflow-x-auto flex items-center gap-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {chat.liveSteps.map((s, i) => {
                  const isLast = i === chat.liveSteps.length - 1
                  return (
                    <span
                      key={`${s.stepIndex}-${s.type}-${i}`}
                      className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                        s.type === 'error'
                          ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                          : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                      } ${isLast ? 'animate-pulse border-[var(--color-accent)] text-[var(--color-accent)]' : ''}`}
                    >
                      <span>{t(`agent.liveStep.${s.type}`)}</span>
                      {s.toolName && <span className="text-[var(--color-primary)]">{s.toolName}</span>}
                      <span className="opacity-60">#{s.stepIndex}</span>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 本次运行统计：步数/耗时/token，点击展开分步明细；新一轮运行/切会话时复位 */}
        {!chat.running && chat.runStats && (
          <div className="mb-2 self-start w-full max-w-[640px]">
            <button
              onClick={toggleStats}
              className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              title={t('agent.runStatsDetail')}
              aria-expanded={statsExpanded}
            >
              <span className="w-3 inline-block">{statsExpanded ? '▾' : '▸'}</span>
              <span>
                {t('agent.runStats', {
                  steps: chat.runStats.stepCount,
                  duration: formatRunDuration(chat.runStats.totalDurationMs),
                  tokens: chat.runStats.totalTokens.toLocaleString('en-US')
                })}
              </span>
            </button>

            {statsExpanded && (
              <div className="mt-1 ml-4 max-h-72 overflow-y-auto border border-[var(--color-border)] rounded p-2 space-y-1 bg-[var(--color-bg-secondary)]">
                {/* 头部：会话累计统计（左） + 复制 JSON 按钮（右） */}
                <div className="flex items-center justify-between gap-2 pb-1 border-b border-[var(--color-border)]">
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {chat.sessionStats
                      ? t('agent.sessionStats', {
                          runs: chat.sessionStats.runCount,
                          duration: formatRunDuration(chat.sessionStats.totalDurationMs),
                          tokens: chat.sessionStats.totalTokens.toLocaleString('en-US')
                        })
                      : t('agent.traceDetail')}
                  </div>
                  <button
                    onClick={handleCopyTraces}
                    disabled={!chat.latestTraces || chat.latestTraces.length === 0}
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] disabled:opacity-40 disabled:hover:text-[var(--color-text-muted)] disabled:hover:border-[var(--color-border)] transition-colors"
                    title={t('agent.copyTraceJson')}
                  >
                    {t('agent.copyTraceJson')}
                  </button>
                </div>
                {chat.tracesLoading && (
                  <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
                )}
                {!chat.tracesLoading && (!chat.latestTraces || chat.latestTraces.length === 0) && (
                  <div className="text-xs text-[var(--color-text-muted)]">{t('agent.traceEmpty')}</div>
                )}
                {!chat.tracesLoading && chat.latestTraces?.map((tr, i) => (
                  <div key={tr.id} className="text-xs leading-relaxed">
                    <div className="flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-[var(--color-text-muted)]">#{i + 1}</span>
                      <span className={tr.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}>
                        {tr.status === 'error' ? '✕' : '✓'}
                      </span>
                      <span>{t(`agent.traceType.${tr.stepType}`)}</span>
                      {tr.toolName && <span className="text-[var(--color-primary)]">{tr.toolName}</span>}
                      <span className="text-[var(--color-text-muted)]">{formatRunDuration(tr.durationMs ?? 0)}</span>
                      {typeof tr.tokenUsage === 'number' && (
                        <span className="text-[var(--color-text-muted)]">{tr.tokenUsage.toLocaleString('en-US')} tokens</span>
                      )}
                    </div>
                    {tr.error && (
                      <div className="ml-4 text-[var(--color-danger)] whitespace-pre-wrap break-all">{tr.error}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 断点恢复：上次运行中止/出错时显示「继续执行」入口 */}
        {chat.interrupted && !chat.running && chat.canSend && (
          <button
            onClick={() => void chat.resume()}
            className="mb-2 self-start text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
          >
            {t('agent.resume')}
          </button>
        )}

        {/* 零调用提示：有工具可用但模型未调用任何工具 */}
        {chat.noToolCallNotice && !chat.running && (
          <div className="mb-2 self-start w-full max-w-[640px] flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-xs">
            <span className="shrink-0">⚠️</span>
            <span className="flex-1 text-[var(--color-text)]">{t('agent.noToolCallNotice')}</span>
            <button
              onClick={() => chat.setNoToolCallNotice(false)}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title={t('common.close')}
            >
              ✕
            </button>
          </div>
        )}

        <AgentComposer
          running={chat.running}
          canSend={chat.canSend}
          att={att}
          onSend={(text) => void chat.send(text, att.attachments)}
          onAbort={chat.abort}
        />
      </div>

      {/* 密码弹窗 — 加密导出/解密导入（对齐 Chat 模块样式） */}
      {cryptoPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setCryptoPrompt(null)}>
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-96 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">
              {cryptoPrompt.kind === 'export' ? t('chatview.exportTitle') : t('chatview.importTitle')}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              {cryptoPrompt.kind === 'export' ? t('chatview.exportPwdHint') : t('chatview.importPwdHint')}
            </p>
            <input
              type="password"
              autoFocus
              value={cryptoPwd}
              onChange={(e) => setCryptoPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmCrypto(); if (e.key === 'Escape') setCryptoPrompt(null) }}
              placeholder={t('common.enterPassword')}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-input-bg)] text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button onClick={() => setCryptoPrompt(null)} className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)]">{t('common.cancel')}</button>
              <button onClick={() => void confirmCrypto()} disabled={!cryptoPwd} className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded disabled:opacity-50 hover:opacity-90">
                {cryptoPrompt.kind === 'export' ? t('chatview.export') : t('chatview.decryptImport')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
