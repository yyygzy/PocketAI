import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'

export interface Tab {
  id: string
  title: string
  moduleId: string
  pinned?: boolean
}

interface TabBarProps {
  tabs: Tab[]
  activeTabId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** 拖拽排序：把 fromId 移动到 toId 之前（同为最后一个时移到末尾） */
  onReorder: (fromId: string, toId: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  /** 弹出到独立窗口 */
  onPopOut: (id: string) => void
}

/** 标签栏：HTML5 拖拽排序 + 中键关闭 + 右键菜单（关闭其他/右侧/独立窗口） */
export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  onReorder,
  onCloseOthers,
  onCloseRight,
  onPopOut
}) => {
  const { t } = useI18n()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 右键菜单：点击其他区域 / Esc 关闭
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const handleDragStart = (e: React.DragEvent, tab: Tab): void => {
    setDragId(tab.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tab.id) // Firefox 需要非空 data 才触发拖拽
  }

  const handleDragOver = (e: React.DragEvent, tab: Tab): void => {
    if (!dragId || dragId === tab.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverId(tab.id)
  }

  const handleDrop = (e: React.DragEvent, tab: Tab): void => {
    e.preventDefault()
    if (dragId && dragId !== tab.id) onReorder(dragId, tab.id)
    setDragId(null)
    setOverId(null)
  }

  const handleDragEnd = (): void => {
    setDragId(null)
    setOverId(null)
  }

  const handleContextMenu = (e: React.MouseEvent, tab: Tab): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
  }

  return (
    <div ref={rootRef} className="flex items-center h-9 bg-[var(--color-sidebar)] border-b border-[var(--color-border)] px-1 gap-0.5 overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          draggable={!tab.pinned}
          onDragStart={(e) => handleDragStart(e, tab)}
          onDragOver={(e) => handleDragOver(e, tab)}
          onDrop={(e) => handleDrop(e, tab)}
          onDragEnd={handleDragEnd}
          onClick={() => onSelect(tab.id)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, tab)}
          className={`group flex items-center gap-2 h-7 px-3 rounded text-xs cursor-pointer whitespace-nowrap shrink-0 transition-[background,box-shadow] ${
            activeTabId === tab.id
              ? 'bg-[var(--color-surface)] text-[var(--color-text)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)]'
          } ${dragId === tab.id ? 'opacity-40' : ''} ${
            overId === tab.id && dragId && dragId !== tab.id
              ? 'ring-2 ring-[var(--color-accent)] ring-inset'
              : ''
          } ${tab.pinned ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
        >
          {tab.pinned && <span title={t('tab.pinned')}>📌</span>}
          <span className="max-w-[120px] truncate">{tab.title}</span>
          {!tab.pinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="opacity-0 group-hover:opacity-100 hover:bg-[var(--color-hover-overlay)] rounded w-4 h-4 flex items-center justify-center text-[10px]"
              title={t('tab.close')}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <button
        onClick={onNew}
        className="h-7 w-7 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] shrink-0"
        title={t('tab.new')}
      >
        +
      </button>

      {menu && (
        <div
          className="fixed z-[9000] min-w-[120px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-xs shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)]"
            onClick={() => {
              onPopOut(menu.tabId)
              setMenu(null)
            }}
          >
            {t('tab.popOut')}
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)]"
            onClick={() => {
              onCloseOthers(menu.tabId)
              setMenu(null)
            }}
          >
            {t('tab.closeOthers')}
          </button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)]"
            onClick={() => {
              onCloseRight(menu.tabId)
              setMenu(null)
            }}
          >
            {t('tab.closeRight')}
          </button>
        </div>
      )}
    </div>
  )
}
