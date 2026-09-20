import React, { useEffect, useRef, useState } from 'react'
import { Sidebar, type ModuleId } from './components/Sidebar'
import { TabBar, type Tab } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { ToolApprovalDialog } from './components/ToolApprovalDialog'
import { ToastProvider } from './components/ToastProvider'
import { FirstRunWizard, type WizardVariant } from './modules/wizard/FirstRunWizard'
import { useI18n } from './i18n'

let tabCounter = 0
const newTabId = () => `tab-${Date.now()}-${++tabCounter}`

const TABS_STORAGE_KEY = 'pocketai.tabs.v1'

/** 从 localStorage 恢复上次标签布局（仅存 moduleId/title/pinned，id 重建）；模块级缓存保证多次调用返回同一实例 */
let persistedCache: Tab[] | null = null
function loadPersistedTabs(): Tab[] {
  if (persistedCache) return persistedCache
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    if (!raw) throw new Error('empty')
    const arr = JSON.parse(raw) as Array<{ moduleId: string; title: string; pinned?: boolean }>
    const tabs = arr
      .filter((x) => x && typeof x.moduleId === 'string' && typeof x.title === 'string')
      .slice(0, 20)
      .map((x) => ({ id: newTabId(), moduleId: x.moduleId, title: x.title, pinned: x.pinned }))
    if (tabs.length === 0) throw new Error('empty')
    persistedCache = tabs
  } catch {
    persistedCache = []
  }
  return persistedCache
}

export default function App() {
  const { t } = useI18n()
  const [activeModule, setActiveModule] = useState<ModuleId>('chat')
  const [collapsed, setCollapsed] = useState(false)
  const [tabs, setTabs] = useState<Tab[]>(
    () => loadPersistedTabs().length > 0
      ? loadPersistedTabs()
      : [{ id: newTabId(), title: t('tab.newChat'), moduleId: 'chat' }]
  )
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    const restored = loadPersistedTabs()
    if (restored.length === 0) return tabs[0].id
    try {
      const savedActive = localStorage.getItem(TABS_STORAGE_KEY + '.active')
      if (savedActive) {
        // 恢复的 id 与重建 id 不同——保存时存的是激活位置 index
        const idx = Number(savedActive)
        if (Number.isInteger(idx) && idx >= 0 && idx < restored.length) return restored[idx].id
      }
    } catch { /* ignore */ }
    return restored[0].id
  })
  const [locked, setLocked] = useState(false)
  const [dbEncrypted, setDbEncrypted] = useState(false)
  const [lockPwd, setLockPwd] = useState('')
  const [lockErr, setLockErr] = useState('')
  // 首启向导：未完成过 → 完整向导；便携盘换电脑 → 精简重检
  const [wizard, setWizard] = useState<WizardVariant | null>(null)

  const activeTab = tabs.find((tb) => tb.id === activeTabId)
  const contentRef = useRef<HTMLDivElement>(null)

  // 锁屏加固：inert 掉遮罩之外的全部内容，阻断 Tab 聚焦/键盘操作/读屏穿透
  // （React 18 对 inert 属性支持不稳定，直接操作 DOM attribute 最可靠）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (locked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [locked])

  // 隐私锁：监听状态变化
  useEffect(() => {
    window.pocketai.getEncryptionStatus().then((s) => setDbEncrypted(s.dbEncrypted))
    window.pocketai.getLockStatus().then((s) => setLocked(s.state === 'locked'))
    const off = window.pocketai.onLockStateChange((e) => {
      setLocked(e.state === 'locked')
      setLockPwd('')
      setLockErr('')
    })
    return off
  }, [])

  // 首启向导 / 换电脑检测（DB 已就绪后查询；失败静默，不影响主功能）
  useEffect(() => {
    window.pocketai
      .getWizardState()
      .then((r) => {
        if (!r.ok || !r.data) return
        if (!r.data.wizardDone) setWizard('full')
        else if (r.data.machineChanged) setWizard('recheck')
      })
      .catch(() => {})
  }, [])

  // 标签布局持久化：顺序 + 激活位置（下次启动恢复）
  useEffect(() => {
    try {
      localStorage.setItem(
        TABS_STORAGE_KEY,
        JSON.stringify(
          tabs.map((tb) => ({ moduleId: tb.moduleId, title: tb.title, pinned: tb.pinned }))
        )
      )
      const idx = tabs.findIndex((tb) => tb.id === activeTabId)
      localStorage.setItem(TABS_STORAGE_KEY + '.active', String(idx >= 0 ? idx : 0))
    } catch {
      // localStorage 不可用时静默（不影响标签功能本身）
    }
  }, [tabs, activeTabId])

  // 上报用户活跃（节流 5s），用于自动锁屏计时
  useEffect(() => {
    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last > 5000) {
        last = now
        window.pocketai.markActive()
      }
    }
    window.addEventListener('mousemove', onActivity)
    window.addEventListener('keydown', onActivity)
    return () => {
      window.removeEventListener('mousemove', onActivity)
      window.removeEventListener('keydown', onActivity)
    }
  }, [])

  // 手动锁屏快捷键：Ctrl/Cmd + L（窗口级，独立窗口也有自己的监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        window.pocketai.lock().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 允许其他模块通过 window 事件请求切换模块（如聊天「另存为笔记」跳到笔记页）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ moduleId: ModuleId }>).detail
      if (detail?.moduleId) handleModuleChange(detail.moduleId)
    }
    window.addEventListener('pocketai:switch-module', handler)
    return () => window.removeEventListener('pocketai:switch-module', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs])

  async function handleUnlock() {
    setLockErr('')
    const res = await window.pocketai.unlock(dbEncrypted ? lockPwd : undefined)
    if (!res.ok) {
      setLockErr(res.error ?? '解锁失败')
    }
  }

  const moduleTitle = (id: ModuleId): string => {
    const map: Record<ModuleId, string> = {
      chat: t('tab.newChat'),
      agent: t('tab.newAgent'),
      skills: t('tab.skills'),
      knowledge: t('tab.knowledge'),
      files: t('tab.files'),
      notes: t('tab.notes'),
      translate: t('tab.translate'),
      image: t('tab.image'),
      sandbox: t('tab.sandbox'),
      steward: t('tab.steward'),
      settings: t('tab.settings')
    }
    return map[id]
  }

  const handleModuleChange = (id: ModuleId) => {
    setActiveModule(id)
    // 切换模块时，若已有该模块标签则激活，否则新建
    const existing = tabs.find((tb) => tb.moduleId === id)
    if (existing) {
      setActiveTabId(existing.id)
    } else {
      const tab: Tab = {
        id: newTabId(),
        title: moduleTitle(id),
        moduleId: id
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    }
  }

  const handleNewTab = () => {
    const tab: Tab = {
      id: newTabId(),
      title: moduleTitle(activeModule),
      moduleId: activeModule
    }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  const handleCloseTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((tb) => tb.id !== id)
      if (id === activeTabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id)
      }
      if (next.length === 0) {
        const tb: Tab = { id: newTabId(), title: t('tab.newChat'), moduleId: 'chat' }
        setActiveTabId(tb.id)
        return [tb]
      }
      return next
    })
  }

  /** 拖拽排序：把 fromId 移动到 toId 的位置（其后），pinned 标签始终保持在开头 */
  const handleReorder = (fromId: string, toId: string) => {
    setTabs((prev) => {
      const from = prev.findIndex((tb) => tb.id === fromId)
      const to = prev.findIndex((tb) => tb.id === toId)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      // pinned 固定在开头（稳定性排序：非 pinned 依次后移）
      const pinned = next.filter((tb) => tb.pinned)
      const normal = next.filter((tb) => !tb.pinned)
      return pinned.length > 0 ? [...pinned, ...normal] : next
    })
  }

  /** 关闭其他标签（保留指定标签与 pinned 标签） */
  const handleCloseOthers = (id: string) => {
    setTabs((prev) => {
      const keep = prev.filter((tb) => tb.id === id || tb.pinned)
      if (!keep.some((tb) => tb.id === activeTabId)) setActiveTabId(id)
      return keep
    })
  }

  /** 关闭右侧标签（pinned 标签不受影响） */
  const handleCloseRight = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((tb) => tb.id === id)
      if (idx < 0) return prev
      const keep = prev.filter((tb, i) => i <= idx || tb.pinned)
      if (!keep.some((tb) => tb.id === activeTabId)) setActiveTabId(id)
      return keep
    })
  }

  /** 弹出到独立窗口：打开 detached 窗口并关闭本窗口对应标签 */
  const handlePopOut = (id: string) => {
    const tab = tabs.find((tb) => tb.id === id)
    if (!tab) return
    window.pocketai
      .openDetachedWindow(tab.moduleId)
      .then((r) => {
        if (r.ok) handleCloseTab(id)
      })
      .catch(() => {})
  }

  return (
    <ToastProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        {/* 主内容容器：锁定时整棵子树被 inert，遮罩本身放在容器外不受影响 */}
        <div ref={contentRef} className="flex flex-1 min-w-0 h-full">
          <Sidebar
            active={activeModule}
            onChange={handleModuleChange}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
          />
          <div className="flex flex-col flex-1 min-w-0">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={setActiveTabId}
              onClose={handleCloseTab}
              onNew={handleNewTab}
              onReorder={handleReorder}
              onCloseOthers={handleCloseOthers}
              onCloseRight={handleCloseRight}
              onPopOut={handlePopOut}
            />
            <Workspace moduleId={(activeTab?.moduleId as ModuleId) || 'chat'} />
          </div>
        </div>

        {/* 工具调用审批弹窗（shell_exec 等）；锁定时不挂载 */}
        {!locked && <ToolApprovalDialog />}

        {/* 首启向导 / 换电脑重检：锁定时让位给锁屏遮罩 */}
        {!locked && wizard && (
          <FirstRunWizard variant={wizard} onClose={() => setWizard(null)} />
        )}

        {locked && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm">
            <div className="w-80 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-8 text-center shadow-2xl">
              <div className="mb-4 text-4xl">🔒</div>
              <h2 className="mb-2 text-xl font-semibold text-[var(--color-text)]">已锁定</h2>
              <p className="mb-6 text-sm text-[var(--color-text-muted)]">PocketAI 隐私保护已激活</p>
              {dbEncrypted && (
                <input
                  type="password"
                  autoFocus
                  value={lockPwd}
                  onChange={(e) => setLockPwd(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                  placeholder="输入主密码解锁"
                  className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-4 py-2 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                />
              )}
              {lockErr && <div className="mb-3 text-sm text-[var(--color-danger)]">{lockErr}</div>}
              <button
                onClick={handleUnlock}
                className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-on-accent)] hover:opacity-90"
              >
                {dbEncrypted ? '解锁' : '立即解锁'}
              </button>
            </div>
          </div>
        )}
      </div>
    </ToastProvider>
  )
}
