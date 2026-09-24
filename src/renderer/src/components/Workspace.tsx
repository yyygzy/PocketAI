import React, { Suspense, lazy } from 'react'
import type { ModuleId } from './Sidebar'
import { ChatModule } from '../modules/chat/ChatModule'
import { useI18n } from '../i18n'

// 首屏核心模块直出（chat 是默认落地页，直出避免首屏 Suspense 闪烁）
// 其余模块按需懒加载，减小首屏 chunk
const SettingsModule = lazy(() => import('../modules/settings/SettingsModule').then((m) => ({ default: m.SettingsModule })))
const StewardModule = lazy(() => import('../modules/steward/StewardModule').then((m) => ({ default: m.StewardModule })))
const KnowledgeModule = lazy(() => import('../modules/knowledge/KnowledgeModule').then((m) => ({ default: m.KnowledgeModule })))
const SkillModule = lazy(() => import('../modules/skills/SkillModule').then((m) => ({ default: m.SkillModule })))
const AgentModule = lazy(() => import('../modules/agent/AgentModule').then((m) => ({ default: m.AgentModule })))
const FilesModule = lazy(() => import('../modules/files/FilesModule').then((m) => ({ default: m.FilesModule })))
const NotesModule = lazy(() => import('../modules/notes/NotesModule').then((m) => ({ default: m.NotesModule })))
const TranslateModule = lazy(() => import('../modules/translate/TranslateModule').then((m) => ({ default: m.TranslateModule })))
const ImageModule = lazy(() => import('../modules/image/ImageModule').then((m) => ({ default: m.ImageModule })))
const SandboxModule = lazy(() => import('../modules/sandbox/SandboxModule').then((m) => ({ default: m.SandboxModule })))

interface WorkspaceProps {
  moduleId: ModuleId
}

/** 模块 chunk 加载时的占位（与应用主题一致） */
const ModuleFallback: React.FC = () => (
  <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
    <span className="animate-pulse">…</span>
  </div>
)

export const Workspace: React.FC<WorkspaceProps> = ({ moduleId }) => {
  const { t } = useI18n()

  if (moduleId === 'chat') return <ChatModule />
  if (moduleId === 'agent') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.agent.title')} subtitle={t('workspace.agent.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <AgentModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (moduleId === 'settings') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.settings.title')} subtitle={t('workspace.settings.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <SettingsModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (moduleId === 'steward') {
    return (
      <div className="flex-1 overflow-auto p-6">
        <Header title={t('workspace.steward.title')} subtitle={t('workspace.steward.subtitle')} />
        <Suspense fallback={<ModuleFallback />}>
          <StewardModule />
        </Suspense>
      </div>
    )
  }
  if (moduleId === 'skills') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.skills.title')} subtitle={t('workspace.skills.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <SkillModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (moduleId === 'knowledge') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.kb.title')} subtitle={t('workspace.kb.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <KnowledgeModule />
          </Suspense>
        </div>
      </div>
    )
  }

  if (moduleId === 'files') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.files.title')} subtitle={t('workspace.files.subtitle')} />
        <div className="h-[calc(100%-3rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <FilesModule />
          </Suspense>
        </div>
      </div>
    )
  }

  if (moduleId === 'notes') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.notes.title')} subtitle={t('workspace.notes.subtitle')} />
        <div className="h-[calc(100%-3rem)] rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg)]">
          <Suspense fallback={<ModuleFallback />}>
            <NotesModule />
          </Suspense>
        </div>
      </div>
    )
  }

  if (moduleId === 'translate') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.translate.title')} subtitle={t('workspace.translate.subtitle')} />
        <div className="h-[calc(100%-3rem)] rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg)]">
          <Suspense fallback={<ModuleFallback />}>
            <TranslateModule />
          </Suspense>
        </div>
      </div>
    )
  }

  if (moduleId === 'image') {
    return (
      <div className="flex-1 overflow-hidden p-5 flex flex-col">
        <Header title={t('workspace.image.title')} subtitle={t('workspace.image.subtitle')} />
        <div className="flex-1 min-h-0">
          <Suspense fallback={<ModuleFallback />}>
            <ImageModule />
          </Suspense>
        </div>
      </div>
    )
  }

  if (moduleId === 'sandbox') {
    return (
      <div className="flex-1 overflow-hidden p-5 flex flex-col">
        <Header title={t('workspace.sandbox.title')} subtitle={t('workspace.sandbox.subtitle')} />
        <div className="flex-1 min-h-0">
          <Suspense fallback={<ModuleFallback />}>
            <SandboxModule />
          </Suspense>
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
