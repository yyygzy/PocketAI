import React from 'react'
import type { ModuleId } from './Sidebar'
import { ChatModule } from '../modules/chat/ChatModule'
import { SettingsModule } from '../modules/settings/SettingsModule'
import { StewardModule } from '../modules/steward/StewardModule'
import { KnowledgeModule } from '../modules/knowledge/KnowledgeModule'
import { SkillModule } from '../modules/skills/SkillModule'
import { AgentModule } from '../modules/agent/AgentModule'
import { FilesModule } from '../modules/files/FilesModule'
import { useI18n } from '../i18n'

interface WorkspaceProps {
  moduleId: ModuleId
}

export const Workspace: React.FC<WorkspaceProps> = ({ moduleId }) => {
  const { t } = useI18n()

  if (moduleId === 'chat') return <ChatModule />
  if (moduleId === 'agent') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.agent.title')} subtitle={t('workspace.agent.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <AgentModule />
        </div>
      </div>
    )
  }
  if (moduleId === 'settings') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.settings.title')} subtitle={t('workspace.settings.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <SettingsModule />
        </div>
      </div>
    )
  }
  if (moduleId === 'steward') {
    return (
      <div className="flex-1 overflow-auto p-6">
        <Header title={t('workspace.steward.title')} subtitle={t('workspace.steward.subtitle')} />
        <StewardModule />
      </div>
    )
  }
  if (moduleId === 'skills') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.skills.title')} subtitle={t('workspace.skills.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <SkillModule />
        </div>
      </div>
    )
  }
  if (moduleId === 'knowledge') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.kb.title')} subtitle={t('workspace.kb.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <KnowledgeModule />
        </div>
      </div>
    )
  }

  if (moduleId === 'files') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.files.title')} subtitle={t('workspace.files.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <FilesModule />
        </div>
      </div>
    )
  }

  return null
}

const Header: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <div className="mb-4">
    <h1 className="text-xl font-bold">{title}</h1>
    {subtitle && <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</p>}
  </div>
)
