import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import { ThemeLangControls } from './ThemeLangControls'
import { ShowingDefaultsNotice } from './ShowingDefaultsNotice'
import { useToast } from './ToastProvider'
import { useAppStore } from '../store/app-store'
import { DETACHABLE_MODULE_IDS, MAX_PINNED_SIDEBAR_MODULES } from '../../../shared/types'
import type { SidebarModuleId } from '../../../shared/types'
import logoUrl from '../assets/logo-128.png'

export type ModuleId = SidebarModuleId

interface SidebarProps {
  active: ModuleId
  onChange: (id: ModuleId) => void
  collapsed: boolean
  onToggleCollapse: () => void
  /** 主窗口传入则显示「待发提醒」入口（独立窗口/浮窗不挂提醒中心） */
  onOpenReminders?: () => void
}

const MODULE_ICONS: Record<ModuleId, string> = {
  chat: '💬',
  agent: '🤖',
  skills: '⚡',
  knowledge: '📚',
  files: '📁',
  notes: '📝',
  translate: '🌐',
  image: '🎨',
  sandbox: '🧩',
  terminal: '🖥️',
  steward: '🛠️',
  settings: '⚙️'
}

/** Ctrl+1..9 只绑可见顺序的前 9 项（与原标签快捷键的覆盖范围一致） */
const SHORTCUT_SLOTS = 9

export const Sidebar: React.FC<SidebarProps> = ({
  active,
  onChange,
  collapsed,
  onToggleCollapse,
  onOpenReminders
}) => {
  const { t } = useI18n()
  const toast = useToast()
  // 顺序与「固定不被休眠」都在 app-store：快捷键要按可见顺序绑定，固定要参与 LRU 淘汰判定
  const order = useAppStore((s) => s.sidebarOrder)
  const setSidebarOrder = useAppStore((s) => s.setSidebarOrder)
  const pinnedModules = useAppStore((s) => s.pinnedModules)
  const setPinnedModules = useAppStore((s) => s.setPinnedModules)
  const toggleModulePinned = useAppStore((s) => s.toggleModulePinned)
  // 正在拖拽的模块 id
  const draggingIdRef = useRef<ModuleId | null>(null)
  const [draggingId, setDraggingId] = useState<ModuleId | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: ModuleId } | null>(null)
  // 待发提醒角标数（仅主窗口挂提醒中心时拉取；到点广播后刷新）
  // null = 这一发读没拿到（V4-Iter-250）：0 会被读成「没有待发提醒」，所以角标分三态
  const [pendingReminders, setPendingReminders] = useState<number | null>(0)
  // §275：侧栏顺序与固定模块的读取失败追踪（两发独立判，避免 Promise.all 一损俱损）
  const [orderUnread, setOrderUnread] = useState<{ error: string } | null>(null)
  const [pinnedUnread, setPinnedUnread] = useState<{ error: string } | null>(null)

  useEffect(() => {
    if (!onOpenReminders) return
    const refresh = () => {
      window.pocketai
        .listReminders()
        .then((list) => {
          if (hasIpcFailed(list)) {
            setPendingReminders(null)
            return
          }
          setPendingReminders(list.length)
        })
        .catch(reportIpcError('sidebar.listReminders'))
    }
    refresh()
    const off = window.pocketai.onReminderFired(() => refresh())
    // 消息右键新建提醒后 ReminderMenu 派发的本地变更事件（无 IPC 广播，用 CustomEvent 轻量通知）
    const onLocalChanged = () => refresh()
    window.addEventListener('pocketai:reminders-changed', onLocalChanged)
    return () => {
      off()
      window.removeEventListener('pocketai:reminders-changed', onLocalChanged)
    }
  }, [onOpenReminders])

  useEffect(() => {
    // §275：两发独立判，避免 Promise.all 一损俱损；失败侧挂原因，成功即收回
    window.pocketai.getSidebarOrder().then((ord) => {
      if (hasIpcFailed(ord)) {
        setOrderUnread({ error: ipcFailText(ord, t('common.unknownError')) })
        return
      }
      setOrderUnread(null)
      if (ord.data) setSidebarOrder(ord.data)
    }).catch((e) => {
      setOrderUnread({ error: errText(e, t('common.unknownError')) })
      logIpcError('sidebar.getOrder', e)
    })
    window.pocketai.getSidebarPinned().then((pin) => {
      if (hasIpcFailed(pin)) {
        setPinnedUnread({ error: ipcFailText(pin, t('common.unknownError')) })
        return
      }
      setPinnedUnread(null)
      if (pin.data) setPinnedModules(pin.data)
    }).catch((e) => {
      setPinnedUnread({ error: errText(e, t('common.unknownError')) })
      logIpcError('sidebar.getPinned', e)
    })
  }, [setSidebarOrder, setPinnedModules, t])

  // §275：重试函数（清 unread 后重读）
  const retryOrder = (): void => {
    setOrderUnread(null)
    window.pocketai.getSidebarOrder().then((ord) => {
      if (hasIpcFailed(ord)) {
        setOrderUnread({ error: ipcFailText(ord, t('common.unknownError')) })
        return
      }
      setOrderUnread(null)
      if (ord.data) setSidebarOrder(ord.data)
    }).catch((e) => {
      setOrderUnread({ error: errText(e, t('common.unknownError')) })
      logIpcError('sidebar.retryOrder', e)
    })
  }
  const retryPinned = (): void => {
    setPinnedUnread(null)
    window.pocketai.getSidebarPinned().then((pin) => {
      if (hasIpcFailed(pin)) {
        setPinnedUnread({ error: ipcFailText(pin, t('common.unknownError')) })
        return
      }
      setPinnedUnread(null)
      if (pin.data) setPinnedModules(pin.data)
    }).catch((e) => {
      setPinnedUnread({ error: errText(e, t('common.unknownError')) })
      logIpcError('sidebar.retryPinned', e)
    })
  }

  // 右键菜单：点击其他区域 / Esc / 再次右键 关闭
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

  // 把 from 位置的模块移动到 to 位置（拖拽悬停时实时预览）
  const moveTo = (fromId: ModuleId, toId: ModuleId) => {
    const from = order.indexOf(fromId)
    const to = order.indexOf(toId)
    if (from < 0 || to < 0 || from === to) return
    const next = [...order]
    next.splice(from, 1)
    next.splice(to, 0, fromId)
    setSidebarOrder(next)
  }

  const rollbackOrder = (): void => {
    window.pocketai
      .getSidebarOrder()
      .then((x) => {
        if (!hasIpcFailed(x) && x.data) setSidebarOrder(x.data)
      })
      .catch(reportIpcError('sidebar.rollbackOrder'))
  }

  const handleDrop = () => {
    const id = draggingIdRef.current
    draggingIdRef.current = null
    setDraggingId(null)
    if (!id) return
    // 落库；失败（返回未持久化或 reject）则回滚到库里那份，不让界面停在"看着排好了其实没存"
    window.pocketai
      .setSidebarOrder(order)
      .then((r) => {
        if (!r.ok || !r.data) rollbackOrder()
      })
      .catch((e) => {
        logIpcError('sidebar.setOrder', e)
        rollbackOrder()
      })
  }

  const popOut = (id: ModuleId): void => {
    void window.pocketai
      .openDetachedWindow(id)
      .then((r) => {
        if (r.ok === false) toast.error(r.error ?? t('sidebar.popOutFailed'))
      })
      .catch(reportIpcError('sidebar.popOut'))
  }

  const pinToggle = (id: ModuleId): void => {
    toggleModulePinned(id)
    const next = useAppStore.getState().pinnedModules
    const rollback = (): void => {
      window.pocketai
        .getSidebarPinned()
        .then((x) => {
          if (!hasIpcFailed(x) && x.data) setPinnedModules(x.data)
        })
        .catch(reportIpcError('sidebar.rollbackPinned'))
    }
    window.pocketai
      .setSidebarPinned(next)
      .then((r) => {
        if (!r.ok || !r.data) rollback()
      })
      .catch((e) => {
        logIpcError('sidebar.setPinned', e)
        rollback()
      })
  }

  const pinFull = pinnedModules.length >= MAX_PINNED_SIDEBAR_MODULES

  return (
    <aside
      className="flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)] transition-all duration-200"
      style={{ width: collapsed ? 56 : 200 }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 h-14 border-b border-[var(--color-border)]">
        <img src={logoUrl} alt="墨匣" className="w-10 h-10 shrink-0" />
        {!collapsed && <span className="font-bold text-base">墨匣</span>}
      </div>

      {/* §275：侧栏顺序与固定模块读取失败提示 */}
      {!collapsed && (orderUnread || pinnedUnread) && (
        <div className="px-3 py-2 border-b border-[var(--color-border)] space-y-1">
          {orderUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShowingDefaultsNotice what={t('sidebar.order')} msg={orderUnread.error} />
              <button
                data-testid="sidebar-order-retry"
                className="btn-ghost text-[11px] py-0.5 px-2 shrink-0"
                onClick={retryOrder}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          {pinnedUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShowingDefaultsNotice what={t('sidebar.pinned')} msg={pinnedUnread.error} />
              <button
                data-testid="sidebar-pinned-retry"
                className="btn-ghost text-[11px] py-0.5 px-2 shrink-0"
                onClick={retryPinned}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* 模块列表（拖拽排序；右键弹出独立窗口 / 固定不被休眠） */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {order.map((id, i) => {
          const pinned = pinnedModules.includes(id)
          const label = t(`sidebar.${id}`)
          return (
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
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, id })
              }}
              title={collapsed ? (pinned ? `${label} · ${t('sidebar.pinnedSuffix')}` : label) : undefined}
              aria-label={label}
              className={`relative w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors cursor-grab active:cursor-grabbing ${
                draggingId === id ? 'opacity-40' : ''
              } ${
                active === id
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] font-semibold'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
              }`}
            >
              {active === id && (
                <span
                  className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r bg-[var(--color-accent)]"
                  aria-hidden
                />
              )}
              <span className={`text-lg shrink-0 ${active === id ? 'opacity-100' : 'opacity-80'}`}>
                {MODULE_ICONS[id]}
              </span>
              {!collapsed && <span className="flex-1 text-left truncate">{label}</span>}
              {/* 固定徽标：折叠成图标栏时靠它 + tooltip 表达"这个模块不会被休眠" */}
              {pinned && (
                <span className="shrink-0 text-[10px]" title={t('sidebar.pinnedSuffix')}>
                  📌
                </span>
              )}
              {!collapsed && i < SHORTCUT_SLOTS && (
                <span className="shrink-0 text-[10px] opacity-60">⌃{i + 1}</span>
              )}
            </button>
          )
        })}
      </nav>

      {/* 待发提醒中心（仅主窗口挂载） */}
      {onOpenReminders && (
        <button
          onClick={onOpenReminders}
          className="relative h-10 border-t border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors flex items-center justify-center gap-2 text-sm"
          title={t('reminder.center.title')}
          aria-label={t('reminder.center.title')}
        >
          <span className="text-base leading-none">⏰</span>
          {!collapsed && <span>{t('reminder.center.entry')}</span>}
          {(pendingReminders === null || pendingReminders > 0) && (
            <span
              className="absolute bg-[var(--color-accent)] text-white text-[9px] leading-none font-semibold rounded-full min-w-[15px] h-[15px] px-1 flex items-center justify-center"
              style={collapsed ? { top: 4, right: 6 } : { top: 4, right: 10 }}
              title={pendingReminders === null ? t('reminder.center.pendingUnread') : undefined}
            >
              {pendingReminders === null ? '?' : pendingReminders > 99 ? '99+' : pendingReminders}
            </span>
          )}
        </button>
      )}

      {/* 主题 + 语言 */}
      <ThemeLangControls collapsed={collapsed} />

      {/* 手动锁屏：立即锁定，清密钥 + 全窗口遮罩 */}
      <button
        onClick={() => window.pocketai.lock().catch(reportIpcError('sidebar.lock'))}
        className="h-10 border-t border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors flex items-center justify-center gap-2 text-sm"
        title={t('enc.lockNow')}
        aria-label={t('sidebar.lock')}
      >
        <span className="text-base leading-none">🔒</span>
        {!collapsed && <span>{t('sidebar.lock')}</span>}
      </button>

      {/* 折叠按钮 */}
      <button
        onClick={onToggleCollapse}
        className="h-10 border-t border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] transition-colors"
        title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
      >
        {collapsed ? '›' : '‹'}
      </button>

      {menu && (
        <div
          className="fixed z-[9000] min-w-[150px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-xs shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)]"
            onClick={() => {
              onChange(menu.id)
              setMenu(null)
            }}
          >
            {t('sidebar.openHere')}
          </button>
          {DETACHABLE_MODULE_IDS.includes(menu.id) && (
            <button
              className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)]"
              onClick={() => {
                popOut(menu.id)
                setMenu(null)
              }}
            >
              {t('sidebar.popOut')}
            </button>
          )}
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-hover-overlay)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!pinnedModules.includes(menu.id) && pinFull}
            title={!pinnedModules.includes(menu.id) && pinFull ? t('sidebar.pinFull') : undefined}
            onClick={() => {
              pinToggle(menu.id)
              setMenu(null)
            }}
          >
            {pinnedModules.includes(menu.id) ? t('sidebar.unpin') : t('sidebar.pin')}
          </button>
        </div>
      )}
    </aside>
  )
}
