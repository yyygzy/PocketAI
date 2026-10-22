// Agent 对话面板：左侧会话栏（可收起） + 右侧配置栏/消息流/输入区（纯组合，逻辑都在 hooks 中）
import React, { useEffect, useRef, useState } from 'react'
import type { ConversationRecord, ReminderRepeatRule } from '../../../../../shared/types'
import { isDelegateRole, parseDelegationResultChildPrefixes } from '../../../../../shared/delegation-rules'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailText } from '../../../utils/ipc'
import { useProviderData } from '../hooks/useProviderData'
import { useAgentChat } from '../hooks/useAgentChat'
import { APP_SHORTCUT_EVENT, isActiveModuleInstance, type AppShortcutEventDetail } from '../../../hooks/useGlobalShortcuts'
import { useAgentToolConfigs } from '../hooks/useAgentToolConfigs'
import { useAttachments } from '../hooks/useAttachments'
import { SessionRail } from '../components/SessionRail'
import { AgentModelBar } from '../components/AgentModelBar'
import { AgentEvalPanel } from './AgentEvalPanel'
import { AgentToolBars } from '../components/AgentToolBars'
import { AgentComposer } from '../components/AgentComposer'
import { VirtualMessageList } from '../components/VirtualMessageList'
import { AgentSearchBar } from '../components/AgentSearchBar'
import { ZeroToolCallNotice } from '../components/ZeroToolCallNotice'
import { formatRunDuration, agentMessagesToMarkdown, searchAgentMessages, delegateRoleLabel } from '../agent-shared'
import { useToast } from '../../../components/ToastProvider'
import { useAppStore } from '../../../store/app-store'
import { errText } from '../../../utils/error'
import { writeClipboard } from '../../../utils/clipboard'
import { buildConversationHtml } from '../../../utils/export-html'
import { buildReminderText, reminderCreatedToastKey } from '../../../utils/reminder-presets'
import { formatDateTime } from '../../../utils/time'
import { formatStepTokens } from '../../../utils/agent-step-tokens'
import { capSelection, buildBatchExportFiles, finishBatchExport, BATCH_EXPORT_MAX, BATCH_PDF_MAX } from '../../../utils/batch-export'

export const AgentPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const { providers, assistants, fetchingModels, fetchModels } = useProviderData()
  const chat = useAgentChat(providers, assistants)
  // busy 上报：Agent 运行中豁免休眠，防止切走标签后被 LRU 卸载导致任务中断
  useEffect(() => {
    useAppStore.getState().setModuleBusy('agent', chat.running)
  }, [chat.running])
  const tools = useAgentToolConfigs()
  const att = useAttachments()
  const [railOpen, setRailOpen] = useState(true)
  const [statsExpanded, setStatsExpanded] = useState(false)
  /** §235：「子代理会话」那一格（本会话派出去过哪几趟） */
  const [subRunsOpen, setSubRunsOpen] = useState(false)
  /** 分步明细里逐条展开「入参／返回」（键=trace 行 id，天然唯一，切会话不用清） */
  const [traceIoOpen, setTraceIoOpen] = useState<Record<string, boolean>>({})

  // ---------- 会话内消息搜索 ----------
  const [searchOpen, setSearchOpen] = useState(false)
  // 评测集那一屏（V4-Iter-242）：默认收起。里面每一发都真花钱，所以不给它自动读、也不自动跑
  const [evalOpen, setEvalOpen] = useState(false)
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
    // §235：那一格的内容是"这条会话派出去过哪几趟"，切会话后旧展开态没意义（列表还在读）
    setSubRunsOpen(false)
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
  const handleRemind = async (
    messageId: string,
    fireAt: number,
    repeatRule?: ReminderRepeatRule
  ) => {
    const msg = chat.messages.find((m) => m.id === messageId)
    const text = msg ? buildReminderText(msg.text ?? '') : ''
    if (!text) {
      toast.error(t('reminder.menu.emptyText'))
      return
    }
    try {
      const r = await window.pocketai.createReminder({
        text,
        fireAt,
        conversationId: chat.conversationId ?? null,
        ...(repeatRule ? { repeatRule } : {})
      })
      // 时间在过去／超 30 天／条数超上限时 reminders.ts 是 throw ⇒ safeHandle 转成 {ok:false}，
      // 不判就是"绿 toast 说已设置提醒"而提醒根本没建（§215）
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      // 通知 Sidebar 角标即时刷新（创建无 IPC 广播，本地事件轻量通知）
      window.dispatchEvent(new Event('pocketai:reminders-changed'))
      toast.success(
        t(reminderCreatedToastKey(repeatRule), {
          time: formatDateTime(fireAt)
        })
      )
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

  // 当前会话标题（用于复制 Markdown 的一级标题）；子代理会话不在侧栏列表里，身份来自那条记录本身
  const currentTitle =
    chat.subSession?.title?.trim() ||
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
      // §219：失败对象不是数组，buildConversationHtml 里的 .map 抛 TypeError，被下面那个 catch 接住后用户看到的是 msgs.map is not a function 这种看不懂的账
      if (hasIpcFailed(msgs)) {
        toast.error(t('chat.exportFail', { e: ipcFailText(msgs, t('common.unknownError')) }))
        return
      }
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
      // §219：失败对象不是数组，buildConversationHtml 里的 .map 抛 TypeError，被下面那个 catch 接住后用户看到的是 msgs.map is not a function 这种看不懂的账
      if (hasIpcFailed(msgs)) {
        toast.error(t('chat.exportFail', { e: ipcFailText(msgs, t('common.unknownError')) }))
        return
      }
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
          conversationsUnread={chat.conversationsUnread}
          archivedUnread={chat.archivedUnread}
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
              workspaceUnread={tools.toolUnread.workspace}
              onPickWorkspace={() => void tools.pickWorkspace()}
              textProtocolForced={chat.textProtocolForced}
              textProtocolUnread={chat.textProtocolUnread}
              onToggleTextProtocol={(on) => chat.setTextProtocol(on)}
              contextWindowTokens={chat.contextWindowTokens}
              contextWindowUnread={chat.contextWindowUnread}
              onSetContextWindow={(tokens) => chat.setContextWindow(tokens)}
              fallbackTarget={chat.fallbackTarget}
              fallbackMissing={chat.fallbackMissing}
              fallbackUnread={chat.fallbackUnread}
              onSetFallback={(target) => chat.setFallback(target)}
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
          {/* 头部快捷：评测集（V4-Iter-242）——"通过率"这句话要能在界面上跑出来，不能只在测试里 */}
          <button
            onClick={() => setEvalOpen((v) => !v)}
            data-testid="agent-eval-toggle"
            aria-pressed={evalOpen}
            title={t('agent.eval.title')}
            className={`shrink-0 mt-0.5 h-7 px-2 rounded-lg text-[11px] transition-colors ${
              evalOpen
                ? 'bg-[var(--color-hover-overlay)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
            }`}
          >
            {t('agent.eval.title')}
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

        {/* §258：这一发是**写**（把当前助手／会话存回 ui_prefs）。失败不当场崩、后果在下次启动，
            所以不弹 toast（会撞在启动那一下），改在这里常驻一句；下一次写成功就收回。 */}
        {chat.uiPrefsUnread && (
          <div role="alert" className="px-2 py-1 text-[11px] leading-snug text-[var(--color-warning)]">
            {t('agent.prefsNotSaved', { msg: chat.uiPrefsUnread })}
          </div>
        )}

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

        {/* §235：正看着的是某趟子代理的独立会话——身份是读出来的（见 useAgentChat 那三态），
            横幅替掉"这条会话为什么不能发消息"的猜测，返回按钮回派出它的那一条 */}
        {chat.subSession && (
          <div
            data-testid="sub-session-banner"
            className="mb-2 self-start w-full max-w-[640px] flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-xs text-[var(--color-text-muted)]"
          >
            <span className="text-[var(--color-accent)]" data-sub-session-role={chat.subSession.roleKey ?? ''}>
              {chat.subSession.roleKey && isDelegateRole(chat.subSession.roleKey)
                ? delegateRoleLabel(t, chat.subSession.roleKey)
                : chat.subSession.title}
            </span>
            <span>{t('agent.subSessionNote')}</span>
            <button
              onClick={chat.backToParentConversation}
              data-testid="sub-session-back"
              className="px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] transition-colors"
            >
              {t('agent.backToParent')}
            </button>
          </div>
        )}
        {/* 身份读不到：不演成"这条会话能发"，也不演成"还在加载"——明说一句并给一次重试（§222 那一族） */}
        {chat.identityUnread && (
          <div
            data-testid="sub-session-unread"
            className="mb-2 self-start w-full max-w-[640px] flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 rounded border border-[var(--color-danger)] text-xs text-[var(--color-danger)]"
          >
            <span title={chat.identityUnread}>{t('agent.identityUnread')}</span>
            <button
              onClick={chat.retrySubSessionReads}
              data-testid="sub-session-retry"
              className="px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
            >
              {t('agent.retryRead')}
            </button>
          </div>
        )}

        {/* 评测集（V4-Iter-242）：跑的是模型栏当前这台，切换会话不影响这一屏——它评的是模型与编排，不是这条对话 */}
        {evalOpen && (
          <AgentEvalPanel
            providerId={chat.providerId}
            model={chat.model}
            targetLabel={`${providers.find((p) => p.id === chat.providerId)?.name ?? chat.providerId} · ${chat.model}`}
            onClose={() => setEvalOpen(false)}
          />
        )}

        {/* 消息流（虚拟化：只渲染可视区，避免长对话 DOM 线性增长） */}
        <VirtualMessageList
          messages={chat.messages}
          running={chat.running}
          conversationId={chat.conversationId}
          emptyHint={t('agent.emptyHint')}
          onDeleteMessage={chat.running || chat.subSessionReadonly ? undefined : (id) => void chat.deleteMessage(id)}
          onRerunMessage={chat.running || chat.subSessionReadonly ? undefined : (id, text) => void chat.rerun(id, text)}
          onRegenerateMessage={
            chat.running || chat.subSessionReadonly ? undefined : (id) => chat.regenerate(id)
          }
          onRemindMessage={
            chat.running || chat.subSessionReadonly
              ? undefined
              : (id, fireAt, repeatRule) => void handleRemind(id, fireAt, repeatRule)
          }
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
                      {/* 委派那一步用角色标签替掉裸工具名：delegate_task 对用户不如"派了谁"有用 */}
                      {s.role ? (
                        <span className="text-[var(--color-accent)]" data-delegate-role={s.role}>
                          {delegateRoleLabel(t, s.role)}
                        </span>
                      ) : (
                        s.toolName && <span className="text-[var(--color-accent)]">{s.toolName}</span>
                      )}
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
              title={
                chat.runStats.childRuns
                  ? `${t('agent.runStatsDetail')} · ${t('agent.runStatsSemantics')}`
                  : t('agent.runStatsDetail')
              }
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
              {/* 子代理那几步不在下面这份明细里（它们挂在子会话上），所以数字比明细大要有话说 */}
              {chat.runStats.childRuns ? (
                <span>{t('agent.runStatsChildren', { n: chat.runStats.childRuns })}</span>
              ) : null}
            </button>

            {statsExpanded && (
              <div className="mt-1 ml-4 max-h-72 overflow-y-auto border border-[var(--color-border)] rounded p-2 space-y-1 bg-[var(--color-bg-secondary)]">
                {/* 头部：会话累计统计（左） + 复制 JSON 按钮（右） */}
                <div className="flex items-center justify-between gap-2 pb-1 border-b border-[var(--color-border)]">
                  <div
                    className="text-xs text-[var(--color-text-muted)]"
                    title={chat.sessionStats?.childRuns ? t('agent.runStatsSemantics') : undefined}
                  >
                    {chat.sessionStats
                      ? t('agent.sessionStats', {
                          runs: chat.sessionStats.runCount,
                          duration: formatRunDuration(chat.sessionStats.totalDurationMs),
                          tokens: chat.sessionStats.totalTokens.toLocaleString('en-US')
                        })
                      : t('agent.traceDetail')}
                    {chat.sessionStats?.childRuns ? (
                      <span>{t('agent.runStatsChildren', { n: chat.sessionStats.childRuns })}</span>
                    ) : null}
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
                {/* §257：那一读失败时以前直接落到「暂无分步明细」＝把没读到演成确实没有；三态分开，并给一次重试 */}
                {!chat.tracesLoading && chat.latestTracesUnread && (
                  <div
                    data-testid="traces-unread"
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-danger)]"
                  >
                    <span title={chat.latestTracesUnread}>{t('common.loadFailed', { msg: chat.latestTracesUnread })}</span>
                    <button
                      data-testid="traces-retry"
                      onClick={chat.loadLatestTraces}
                      className="px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
                    >
                      {t('agent.retryRead')}
                    </button>
                  </div>
                )}
                {!chat.tracesLoading && !chat.latestTracesUnread && (!chat.latestTraces || chat.latestTraces.length === 0) && (
                  <div className="text-xs text-[var(--color-text-muted)]">{t('agent.traceEmpty')}</div>
                )}
                {!chat.tracesLoading &&
                  chat.latestTraces?.map((tr, i) => {
                    const stepTokens = formatStepTokens(tr, t)
                    const ioOpen = traceIoOpen[tr.id] ?? false
                    // 这一步派出去的那几趟子会话：拿返回值头部里的 8 位前缀去直接子会话中找命中。
                    // 一个前缀命中 0 个或 ≥2 个都不给入口（宁可不给，也不赌是哪一趟），列表那一格照样能翻；
                    // 同一步并行委派好几趟时，每个唯一命中各给一个按钮
                    const kids = parseDelegationResultChildPrefixes(tr.toolResult)
                      .map((p) => chat.subSessions.filter((s) => s.id.slice(0, 8) === p))
                      .filter((list) => list.length === 1)
                      .map((list) => list[0] as ConversationRecord)
                    const hasIo = !!(tr.toolArgs || tr.toolResult || tr.model)
                    const rowClass = 'flex flex-wrap items-baseline gap-x-1.5'
                    const line = (
                      <>
                        <span className="text-[var(--color-text-muted)]">#{i + 1}</span>
                        <span className={tr.status === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}>
                          {tr.status === 'error' ? '✕' : '✓'}
                        </span>
                        <span>{t(`agent.traceType.${tr.stepType}`)}</span>
                        {tr.toolName && <span className="text-[var(--color-accent)]">{tr.toolName}</span>}
                        <span className="text-[var(--color-text-muted)]">{formatRunDuration(tr.durationMs ?? 0)}</span>
                        {stepTokens && <span className="text-[var(--color-text-muted)]">{stepTokens}</span>}
                      </>
                    )
                    return (
                      <div key={tr.id} className="text-xs leading-relaxed">
                        {/* 整行就是开关（▸/▾ 与上面那条统计头同一个动作语言）；只有真有东西可展开时它才是按钮 */}
                        {hasIo ? (
                          <button
                            type="button"
                            onClick={() => setTraceIoOpen((p) => ({ ...p, [tr.id]: !ioOpen }))}
                            aria-expanded={ioOpen}
                            data-testid={`trace-io-${tr.id}`}
                            title={t('agent.traceIo')}
                            className={`${rowClass} w-full text-left hover:opacity-70 transition-opacity`}
                          >
                            <span className="w-3 inline-block text-[var(--color-text-muted)]">
                              {ioOpen ? '▾' : '▸'}
                            </span>
                            {line}
                          </button>
                        ) : (
                          <div className={rowClass}>{line}</div>
                        )}
                        {tr.error && (
                          <div className="ml-4 text-[var(--color-danger)] whitespace-pre-wrap break-all">{tr.error}</div>
                        )}
                        {/* 子会话入口单独一行：嵌进整行按钮里会把点击搞糊（点开子会话不该顺手收起这一行） */}
                        {kids.length > 0 && (
                          <div className="ml-4 mt-0.5 flex flex-wrap gap-x-1.5">
                            {kids.map((k) => (
                              <button
                                key={k.id}
                                onClick={() => chat.openSubSession(k.id)}
                                data-testid={`trace-open-sub-${tr.id}`}
                                className="px-1 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:opacity-80 transition-opacity"
                              >
                                {t('agent.openSubSession')}
                              </button>
                            ))}
                          </div>
                        )}
                        {hasIo && ioOpen && (
                          <div className="ml-4 mt-1 space-y-1">
                            {tr.model && (
                              <div data-testid="trace-model" className="text-[var(--color-text-muted)]">
                                {t('agent.traceModel')}：{tr.model}
                              </div>
                            )}
                            {tr.toolArgs && (
                              <div
                                data-testid="trace-args"
                                className="max-h-40 overflow-y-auto px-1.5 py-1 rounded border border-[var(--color-border)] whitespace-pre-wrap break-all"
                              >
                                {t('agent.traceArgs')}：{tr.toolArgs}
                              </div>
                            )}
                            {tr.toolResult && (
                              <div
                                data-testid="trace-result"
                                className="max-h-40 overflow-y-auto px-1.5 py-1 rounded border border-[var(--color-border)] whitespace-pre-wrap break-all"
                              >
                                {t('agent.traceResult')}：{tr.toolResult}
                              </div>
                            )}
                          </div>
                        )}
                        {!hasIo && (
                          // 这三列是 v50 才有的：旧行留 NULL。空白会被读成"这一步什么都没传"，
                          // 所以要说"没记录"，不能演成"没有"（§222 那一族）
                          <div data-testid="trace-no-io" className="ml-4 text-[var(--color-text-muted)]">
                            {t('agent.traceNoIo')}
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        )}

        {/* §235：委派跑完只在父的统计里留一个数字，过程一直打不开。这一格是那条入口。
            口径写死在这里：**本会话的全部直接子会话**（父子链接在会话行上，trace 才带运行号，
            所以这里不冒充"本次运行的那几个"） */}
        {chat.subSessionsUnread && (
          // 读不到这一句**不藏在折叠态后面**：折叠起来就等于没说过（§222 那一族）
          <div
            data-testid="sub-sessions-unread"
            className="mb-2 self-start w-full max-w-[640px] flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 rounded border border-[var(--color-danger)] text-xs text-[var(--color-danger)]"
          >
            <span title={chat.subSessionsUnread}>{t('agent.subSessionsUnread')}</span>
            <button
              onClick={chat.retrySubSessionReads}
              data-testid="sub-sessions-retry"
              className="px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:text-[var(--color-text)] transition-colors"
            >
              {t('agent.retryRead')}
            </button>
          </div>
        )}
        {chat.subSessions.length > 0 && (
          <div className="mb-2 self-start w-full max-w-[640px]">
            <button
              onClick={() => setSubRunsOpen((v) => !v)}
              aria-expanded={subRunsOpen}
              data-testid="sub-sessions-toggle"
              className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              <span className="w-3 inline-block">{subRunsOpen ? '▾' : '▸'}</span>
              <span>{t('agent.subSessions', { n: chat.subSessions.length })}</span>
            </button>
            {subRunsOpen && (
              <div className="mt-1 ml-4 max-h-48 overflow-y-auto border border-[var(--color-border)] rounded p-2 space-y-1 bg-[var(--color-bg-secondary)]">
                {chat.subSessions.map((k) => (
                  <div key={k.id} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                    <span data-testid={`sub-session-title-${k.id}`}>
                      {k.roleKey && isDelegateRole(k.roleKey) ? delegateRoleLabel(t, k.roleKey) : k.title}
                    </span>
                    <span className="text-[var(--color-text-muted)]">{formatDateTime(k.createdAt)}</span>
                    {k.modelLabel && <span className="text-[var(--color-text-muted)]">{k.modelLabel}</span>}
                    <button
                      onClick={() => chat.openSubSession(k.id)}
                      data-testid={`sub-session-open-${k.id}`}
                      className="px-1.5 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:opacity-80 transition-opacity"
                    >
                      {t('agent.openSubSession')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 断点恢复：上次运行中止/出错时显示「继续执行」入口（子会话/读不到身份时不给：那是往机器会话里写） */}
        {chat.interrupted && !chat.running && chat.canSend && !chat.subSessionReadonly && (
          <button
            onClick={() => void chat.resume()}
            className="mb-2 self-start text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-hover-overlay)] transition-colors"
          >
            {t('agent.resume')}
          </button>
        )}

        {/* 零调用提示：有工具可用但模型未调用任何工具（两条「为什么」互斥，见组件内注释） */}
        {chat.noToolCallNotice && !chat.running && (
          <ZeroToolCallNotice
            mcpHeldBack={chat.mcpHeldBack}
            providerId={chat.providerId}
            model={chat.model}
            textProtocolForced={chat.textProtocolForced}
            onClose={() => chat.setNoToolCallNotice(false)}
            onEnableTextProtocol={() => void chat.setTextProtocol(true)}
          />
        )}

        {/* §237：这一轮的历史被裁到只带最近一问。判据是**我们自己那把尺子**算出来的
            （声明过窗口、且固定开销已把它吃光）——没声明过的模型量不了，就一句都不说，不猜。 */}
        {chat.historyTight && !chat.running && (
          <div
            className="mb-2 flex items-start gap-2 text-xs rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2"
            data-testid="history-tight-notice"
          >
            <span className="flex-1 leading-snug">{t('agent.historyTightHint')}</span>
            <button
              onClick={chat.dismissHistoryTight}
              className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              aria-label={t('common.close')}
              data-testid="history-tight-close"
            >
              ×
            </button>
          </div>
        )}

        {/* 只读那一档**不渲染**输入区，而不是渲染一个禁用框：禁用框不吭声，用户只知道"发不出去"；
            上面那条横幅/读不到的句子已经把为什么说了，这里就不再重复一句（同一条判据只说一次） */}
        {!chat.subSessionReadonly && (
          <AgentComposer
            running={chat.running}
            canSend={chat.canSend}
            att={att}
            onSend={(text) => {
              // 失败收口在 useAgentChat.send 里（返回值＋reject 两条都会落到同一个 toast）
              void chat.send(text, att.attachments)
            }}
            onAbort={chat.abort}
            queue={chat.queue}
            queueFull={chat.queueFull}
            onQueue={chat.enqueueText}
            onInterject={chat.interjectText}
            onDropQueued={chat.dropQueued}
            onSendQueuedNow={chat.sendQueuedNow}
          />
        )}
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
              <button onClick={() => setCryptoPrompt(null)} className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover-overlay)]">{t('common.cancel')}</button>
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
