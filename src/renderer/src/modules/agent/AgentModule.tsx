// Agent 模块入口：MCP Server 管理 + Work Agent 对话 + IM Bot 网关（三个子标签）
import React, { useState } from 'react'
import { useI18n } from '../../i18n'
import { TabBtn } from './ui'
import type { Tab } from './agent-shared'
import { AgentPanel } from './chat/AgentPanel'
import { McpPanel } from './mcp/McpPanel'
import { ChannelsPanel } from './channels/ChannelsPanel'

export const AgentModule: React.FC = () => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('agent')

  return (
    <div className="flex flex-col h-full">
      {/* 子标签：Agent 对话放前面（主功能） */}
      <div className="flex gap-1 mb-3 border-b border-[var(--color-border)]">
        <TabBtn active={tab === 'agent'} onClick={() => setTab('agent')}>
          {t('agent.tabChat')}
        </TabBtn>
        <TabBtn active={tab === 'servers'} onClick={() => setTab('servers')}>
          {t('agent.tabServers')}
        </TabBtn>
        <TabBtn active={tab === 'channels'} onClick={() => setTab('channels')}>
          {t('channel.tab')}
        </TabBtn>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'agent' ? <AgentPanel /> : tab === 'servers' ? <McpPanel /> : <ChannelsPanel />}
      </div>
    </div>
  )
}
