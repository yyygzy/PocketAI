// Agent 对话面板：左侧会话栏 + 右侧配置栏/消息流/输入区（纯组合，逻辑都在 hooks 中）
import React from 'react'
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

export const AgentPanel: React.FC = () => {
  const { t } = useI18n()
  const { providers, assistants, fetchingModels, fetchModels } = useProviderData()
  const chat = useAgentChat(providers)
  const tools = useAgentToolConfigs()
  const att = useAttachments()

  return (
    <div className="flex gap-3 h-full">
      <SessionRail
        assistants={assistants}
        assistantId={chat.assistantId}
        onAssistantChange={chat.setAssistantId}
        conversations={chat.conversations}
        conversationId={chat.conversationId}
        onSelect={chat.selectConversation}
        onNew={() => void chat.newConversation()}
        onDelete={(id) => void chat.deleteConversation(id)}
      />

      {/* 右：对话区 */}
      <div className="flex-1 flex flex-col min-w-0">
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

        <AgentToolBars tools={tools} />

        {/* 消息流（虚拟化：只渲染可视区，避免长对话 DOM 线性增长） */}
        <VirtualMessageList
          messages={chat.messages}
          running={chat.running}
          conversationId={chat.conversationId}
          emptyHint={t('agent.emptyHint')}
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
    </div>
  )
}
