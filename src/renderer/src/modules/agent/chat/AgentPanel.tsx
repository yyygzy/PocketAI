// Agent 对话面板：左侧会话栏（可收起） + 右侧配置栏/消息流/输入区（纯组合，逻辑都在 hooks 中）
import React, { useState } from 'react'
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
