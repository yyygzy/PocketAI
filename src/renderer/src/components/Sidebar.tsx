import React from 'react'
import { useI18n } from '../i18n'
import { ThemeLangControls } from './ThemeLangControls'

export type ModuleId =
  | 'chat'
  | 'agent'
  | 'skills'
  | 'knowledge'
  | 'files'
  | 'steward'
  | 'settings'

interface SidebarProps {
  active: ModuleId
  onChange: (id: ModuleId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const MODULE_IDS: ModuleId[] = ['chat', 'agent', 'skills', 'knowledge', 'files', 'steward', 'settings']
const MODULE_ICONS: Record<ModuleId, string> = {
  chat: '💬',
  agent: '🤖',
  skills: '⚡',
  knowledge: '📚',
  files: '📁',
  steward: '🛠️',
  settings: '⚙️'
}

export const Sidebar: React.FC<SidebarProps> = ({
  active,
  onChange,
  collapsed,
  onToggleCollapse
}) => {
  const { t } = useI18n()

  return (
    <aside
      className="flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)] transition-all duration-200"
      style={{ width: collapsed ? 56 : 200 }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 h-12 border-b border-[var(--color-border)]">
        <span className="text-xl">🎒</span>
        {!collapsed && <span className="font-bold text-sm">PocketAI</span>}
      </div>

      {/* 模块列表 */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {MODULE_IDS.map((id) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            title={t(`sidebar.${id}`)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors ${
              active === id
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
            }`}
          >
            <span className="text-lg shrink-0">{MODULE_ICONS[id]}</span>
            {!collapsed && <span className="truncate">{t(`sidebar.${id}`)}</span>}
          </button>
        ))}
      </nav>

      {/* 主题 + 语言 */}
      <ThemeLangControls collapsed={collapsed} />

      {/* 折叠按钮 */}
      <button
        onClick={onToggleCollapse}
        className="h-10 border-t border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors"
        title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
      >
        {collapsed ? '›' : '‹'}
      </button>
    </aside>
  )
}
