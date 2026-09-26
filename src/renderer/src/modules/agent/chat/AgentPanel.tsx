// Agent 对话面板：左侧会话栏（可收起） + 右侧配置栏/消息流/输入区（纯组合，逻辑都在 hooks 中）
import React, { useEffect, useState } from 'react'
import { useI18n } from '../../../i18n'
import { useProviderData } from '../hooks/useProviderData'
import { useAgentChat } from '../hooks/useAgentChat'
import { useAgentToolConfigs } from '../hooks/useAgentToolConfigs'
import { useAttachments } from '../hooks/useAttachments'
import { SessionRail } from '../components/SessionRail'
import { AgentModelBar } from '../components/AgentModelBar'
import { AgentToolBars } from '../components/AgentToolBars'
import { AgentComposer } from '../components/AgentComposer'
import { VirtualMessageList } from '../components/VirtualMessageList'
import { formatRunDuration } from '../agent-shared'
import { useToast } from '../../../components/ToastProvider'
import { errText } from '../../../utils/error'

export const AgentPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const { providers, assistants, fetchingModels, fetchModels } = useProviderData()
  const chat = useAgentChat(providers)
  const tools = useAgentToolConfigs()
  const att = useAttachments()
  const [railOpen, setRailOpen] = useState(true)
  const [statsExpanded, setStatsExpanded] = useState(false)

  // 切换会话后收起分步明细（明细数据由 hook 在切会话时清空，展开态同步复位）
  useEffect(() => { setStatsExpanded(false) }, [chat.conversationId])

  const toggleStats = () => {
    const next = !statsExpanded
    setStatsExpanded(next)
    if (next && chat.latestTraces === null) chat.loadLatestTraces()
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
          onExportEncrypted={(id) => { setCryptoPwd(''); setCryptoPrompt({ kind: 'export', id }) }}
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
        </div>

        <AgentToolBars tools={tools} />

        {/* 消息流（虚拟化：只渲染可视区，避免长对话 DOM 线性增长） */}
        <VirtualMessageList
          messages={chat.messages}
          running={chat.running}
          conversationId={chat.conversationId}
          emptyHint={t('agent.emptyHint')}
          onDeleteMessage={chat.running ? undefined : (id) => void chat.deleteMessage(id)}
          onRerunMessage={chat.running ? undefined : (id) => void chat.rerun(id)}
        />

        {/* 运行中：实时步数提示（step 事件实时更新，结束后丢弃） */}
        {chat.running && (
          <div className="mb-2 self-start text-xs text-[var(--color-text-muted)] flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
            <span>{t('agent.runningStep', { n: chat.currentStep })}</span>
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
              <div className="mt-1 ml-4 max-h-56 overflow-y-auto border border-[var(--color-border)] rounded p-2 space-y-1 bg-[var(--color-bg-secondary)]">
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
