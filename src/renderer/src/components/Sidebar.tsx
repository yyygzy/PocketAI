import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { ThemeLangControls } from './ThemeLangControls'
import type { SidebarModuleId } from '../../../shared/types'

export type ModuleId = SidebarModuleId

interface SidebarProps {
  active: ModuleId
  onChange: (id: ModuleId) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

const MODULE_IDS: ModuleId[] = ['chat', 'agent', 'skills', 'knowledge', 'files', 'notes', 'translate', 'image', 'sandbox', 'steward', 'settings']
const MODULE_ICONS: Record<ModuleId, string> = {
  chat: '💬',
  agent: '🤖',
  skills: '⚡',
  knowledge: '📚',
  files: '📁',
  notes: '📝',
  translate: '🌐',
  image: '🎨',
  sandbox: '🧪',
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
  // 用户自定义的模块顺序（app_config: sidebar.order）
  const [order, setOrder] = useState<ModuleId[]>(MODULE_IDS)
  // 正在拖拽的模块 id
  const draggingIdRef = useRef<ModuleId | null>(null)
  const [draggingId, setDraggingId] = useState<ModuleId | null>(null)

  useEffect(() => {
    window.pocketai
      .getSidebarOrder()
      .then((r) => {
        if (r.ok && r.data && r.data.length === MODULE_IDS.length) setOrder(r.data)
      })
      .catch(() => {
        /* 读取失败保持默认顺序 */
      })
  }, [])

  // 把 from 位置的模块移动到 to 位置（拖拽悬停时实时预览）
  const moveTo = (fromId: ModuleId, toId: ModuleId) => {
    setOrder((prev) => {
      const from = prev.indexOf(fromId)
      const to = prev.indexOf(toId)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, fromId)
      return next
    })
  }

  const handleDrop = () => {
    const id = draggingIdRef.current
    draggingIdRef.current = null
    setDraggingId(null)
    if (!id) return
    // 落库；失败则回滚到服务端（已持久化）的顺序
    const finalOrder = order
    window.pocketai.setSidebarOrder(finalOrder).then((r) => {
      if (!r.ok || !r.data) {
        window.pocketai
          .getSidebarOrder()
          .then((x) => x.ok && x.data && setOrder(x.data))
          .catch(() => {})
      }
    })
  }

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

      {/* 模块列表（可拖拽排序） */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {order.map((id) => (
          <button
            key={id}
            draggable
            onDragStart={(e) => {
              draggingIdRef.current = id
              setDraggingId(id)
              e.dataTransfer.effectAllowed = 'move'
              // Firefox 需要 setData 才会触发拖拽
              try {
                e.dataTransfer.setData('text/plain', id)
              } catch {
                /* 忽略 */
              }
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const fromId = draggingIdRef.current
              if (fromId && fromId !== id) moveTo(fromId, id)
            }}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop()
            }}
            onDragEnd={() => {
              // 未在有效目标上松手时也要复位高亮
              draggingIdRef.current = null
              setDraggingId(null)
            }}
            onClick={() => onChange(id)}
            title={t(`sidebar.${id}`)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors cursor-grab active:cursor-grabbing ${
              draggingId === id ? 'opacity-40' : ''
            } ${
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

      {/* 手动锁屏：立即锁定，清密钥 + 全窗口遮罩 */}
      <button
        onClick={() => window.pocketai.lock().catch(() => {})}
        className="h-10 border-t border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors flex items-center justify-center gap-2 text-sm"
        title={t('enc.lockNow')}
      >
        <span className="text-base leading-none">🔒</span>
        {!collapsed && <span>{t('sidebar.lock')}</span>}
      </button>

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
