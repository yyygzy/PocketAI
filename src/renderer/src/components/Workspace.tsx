import React, { Suspense, lazy } from 'react'
import type { ModuleId } from './Sidebar'
import { ChatModule } from '../modules/chat/ChatModule'
import { useI18n } from '../i18n'
import { useAppStore } from '../store/app-store'

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
const TerminalModule = lazy(() => import('../modules/terminal/TerminalModule').then((m) => ({ default: m.TerminalModule })))

interface WorkspaceProps {
  activeModule: ModuleId
}

/** 模块 chunk 加载时的占位（与应用主题一致） */
const ModuleFallback: React.FC = () => (
  <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
    <span className="animate-pulse">…</span>
  </div>
)

/** 各模块内容（与原单模块渲染结构一一对应；chat 无外壳直出） */
const ModuleBody: React.FC<{ id: ModuleId }> = ({ id }) => {
  const { t } = useI18n()

  if (id === 'chat') return <ChatModule />
  if (id === 'agent') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.agent.title')} subtitle={t('workspace.agent.subtitle')} />
        <div className="h-[calc(100%-2.25rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <AgentModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'settings') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.settings.title')} subtitle={t('workspace.settings.subtitle')} />
        <div className="h-[calc(100%-2.25rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <SettingsModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'steward') {
    return (
      <div className="flex-1 overflow-auto p-6">
        <Header title={t('workspace.steward.title')} subtitle={t('workspace.steward.subtitle')} />
        <Suspense fallback={<ModuleFallback />}>
          <StewardModule />
        </Suspense>
      </div>
    )
  }
  if (id === 'skills') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.skills.title')} subtitle={t('workspace.skills.subtitle')} />
        <div className="h-[calc(100%-2.25rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <SkillModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'knowledge') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.kb.title')} subtitle={t('workspace.kb.subtitle')} />
        <div className="h-[calc(100%-2.25rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <KnowledgeModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'files') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.files.title')} subtitle={t('workspace.files.subtitle')} />
        <div className="h-[calc(100%-2.25rem)]">
          <Suspense fallback={<ModuleFallback />}>
            <FilesModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'notes') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.notes.title')} subtitle={t('workspace.notes.subtitle')} />
        <div className="h-[calc(100%-2.25rem)] rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg)]">
          <Suspense fallback={<ModuleFallback />}>
            <NotesModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'translate') {
    return (
      <div className="flex-1 overflow-hidden p-5">
        <Header title={t('workspace.translate.title')} subtitle={t('workspace.translate.subtitle')} />
        <div className="h-[calc(100%-2.25rem)] rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg)]">
          <Suspense fallback={<ModuleFallback />}>
            <TranslateModule />
          </Suspense>
        </div>
      </div>
    )
  }
  if (id === 'image') {
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
  if (id === 'sandbox') {
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
  if (id === 'terminal') {
    return (
      <div className="flex-1 overflow-hidden p-5 flex flex-col">
        <Header title={t('workspace.terminal.title')} subtitle={t('workspace.terminal.subtitle')} />
        <div className="flex-1 min-h-0">
          <Suspense fallback={<ModuleFallback />}>
            <TerminalModule />
          </Suspense>
        </div>
      </div>
    )
  }

  return null
}

/**
 * 工作区：已挂载模块全部保留在 DOM 中（保活），
 * 非活动模块 display:none——组件 state / 滚动位置 / 输入草稿全部保留；
 * 超过 MAX_KEPT_MODULES 时由 app-store 按 LRU 淘汰（dormant 卸载，重挂按需重建）。
 */
export const Workspace: React.FC<WorkspaceProps> = ({ activeModule }) => {
  const mountedModules = useAppStore((s) => s.mountedModules)
  // 防御：活动模块必须在挂载集合中（独立窗口 / store 尚未 touch 的首帧）
  const visible = mountedModules.includes(activeModule) ? mountedModules : [...mountedModules, activeModule]

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {visible.map((id) => (
        <div
          key={id}
          data-active-module={id === activeModule ? id : undefined}
          aria-hidden={id !== activeModule}
          className={id === activeModule ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
        >
          <ModuleBody id={id} />
        </div>
      ))}
    </div>
  )
}

const Header: React.FC<{ title: string; subtitle?: string }> = ({ title, subtitle }) => (
  <div className="mb-3 flex items-baseline gap-2">
    <h1 className="text-lg font-bold">{title}</h1>
    {subtitle && <p className="text-xs text-[var(--color-text-muted)]">{subtitle}</p>}
  </div>
)
