import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar, type ModuleId } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { Workspace } from './components/Workspace'
import { LockOverlay } from './components/LockOverlay'
import { ToolApprovalDialog } from './components/ToolApprovalDialog'
import { SelectionToolbar } from './components/SelectionToolbar'
import { CommandPalette } from './components/CommandPalette'
import { ToastProvider } from './components/ToastProvider'
import { ReminderListener } from './hooks/ReminderListener'
import { BudgetWarningListener } from './hooks/BudgetWarningListener'
import { RemindersModal } from './components/RemindersModal'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { FirstRunWizard } from './modules/wizard/FirstRunWizard'
import { useI18n } from './i18n'
import { reportIpcError } from './utils/ipc'
import { startLongTaskObserver } from './utils/longtask'
import { useAppStore } from './store/app-store'

export default function App() {
  const { t } = useI18n()

  // 跨模块状态从全局 store 读取
  const activeModule = useAppStore((s) => s.activeModule)
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const locked = useAppStore((s) => s.locked)
  const dbEncrypted = useAppStore((s) => s.dbEncrypted)
  const wizard = useAppStore((s) => s.wizard)

  const switchModule = useAppStore((s) => s.switchModule)
  const newTab = useAppStore((s) => s.newTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const closeOthers = useAppStore((s) => s.closeOthers)
  const closeRight = useAppStore((s) => s.closeRight)
  const togglePin = useAppStore((s) => s.togglePin)
  const touchModule = useAppStore((s) => s.touchModule)
  const setActiveTabId = useAppStore((s) => s.setActiveTabId)
  const setLocked = useAppStore((s) => s.setLocked)
  const setDbEncrypted = useAppStore((s) => s.setDbEncrypted)
  const setWizard = useAppStore((s) => s.setWizard)

  // 仅 UI 本地状态：锁屏密码输入
  const [collapsed, setCollapsed] = useState(false)
  // 待发提醒中心（仅主窗口；独立窗口/浮窗不挂）
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [lockPwd, setLockPwd] = useState('')
  const [lockErr, setLockErr] = useState('')

  const activeTab = tabs.find((tb) => tb.id === activeTabId)
  const contentRef = useRef<HTMLDivElement>(null)

  // 标签/模块切换：更新保活 LRU（挂载新模块、超阈值时休眠最久未访问者）
  useEffect(() => {
    touchModule(activeModule)
  }, [activeModule, touchModule])

  // 渲染层长任务观测（实测定位界面卡顿；不支持的环境静默跳过）
  useEffect(() => {
    startLongTaskObserver()
  }, [])

  // 锁屏加固：inert 掉遮罩之外的全部内容
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (locked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [locked])

  // 隐私锁：监听状态变化
  useEffect(() => {
    window.pocketai.getEncryptionStatus().then((s) => setDbEncrypted(s.dbEncrypted)).catch(reportIpcError('app.getEncryptionStatus'))
    window.pocketai.getLockStatus().then((s) => setLocked(s.state === 'locked')).catch(reportIpcError('app.getLockStatus'))
    const off = window.pocketai.onLockStateChange((e) => {
      setLocked(e.state === 'locked')
      setLockPwd('')
      setLockErr('')
    })
    return off
  }, [setDbEncrypted, setLocked])

  // 首启向导 / 换电脑检测
  useEffect(() => {
    window.pocketai
      .getWizardState()
      .then((r) => {
        if (!r.ok || !r.data) return
        if (!r.data.wizardDone) setWizard('full')
        else if (r.data.machineChanged) setWizard('recheck')
      })
      .catch(reportIpcError('app.getWizardState'))
  }, [setWizard])

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

  // 应用内全局快捷键中枢（Ctrl+数字切标签 / Ctrl+W 关标签 / Ctrl+, 设置 / Ctrl+L 锁屏 / 会话类）
  useGlobalShortcuts()

  // 模块 → 标签标题（语言切换时随之更新）
  const moduleTitle = useCallback(
    (id: ModuleId): string => {
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
        terminal: t('tab.terminal'),
        steward: t('tab.steward'),
        settings: t('tab.settings')
      }
      return map[id]
    },
    [t]
  )

  const handleModuleChange = useCallback(
    (id: ModuleId) => {
      switchModule(id, moduleTitle(id))
    },
    [switchModule, moduleTitle]
  )

  // 允许其他模块通过 window 事件请求切换模块（如聊天「另存为笔记」跳到笔记页）
  // 保留此入口兼容现有调用方；新代码可直接 useAppStore.getState().switchModule
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ moduleId: ModuleId }>).detail
      if (detail?.moduleId) handleModuleChange(detail.moduleId)
    }
    window.addEventListener('pocketai:switch-module', handler)
    return () => window.removeEventListener('pocketai:switch-module', handler)
  }, [handleModuleChange])

  async function handleUnlock() {
    setLockErr('')
    const res = await window.pocketai.unlock(dbEncrypted ? lockPwd : undefined)
    if (!res.ok) {
      setLockErr(res.error ?? t('lock.unlockFailed'))
    }
  }

  const handleNewTab = () => newTab(moduleTitle(activeModule))

  const handlePopOut = (id: string) => {
    const tab = tabs.find((tb) => tb.id === id)
    if (!tab) return
    window.pocketai
      .openDetachedWindow(tab.moduleId)
      .then((r) => {
        if (r.ok) closeTab(id)
      })
      .catch(reportIpcError('app.openDetached'))
  }

  return (
    <ToastProvider>
      <ReminderListener />
      <BudgetWarningListener />
      <div className="flex h-screen w-screen overflow-hidden">
        <div ref={contentRef} className="flex flex-1 min-w-0 h-full">
          <Sidebar
            active={activeModule}
            onChange={handleModuleChange}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            onOpenReminders={() => setRemindersOpen(true)}
          />
          <div className="flex flex-col flex-1 min-w-0">
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelect={setActiveTabId}
              onClose={closeTab}
              onNew={handleNewTab}
              onReorder={reorderTabs}
              onCloseOthers={closeOthers}
              onCloseRight={closeRight}
              onTogglePin={togglePin}
              onPopOut={handlePopOut}
            />
            <Workspace activeModule={(activeTab?.moduleId as ModuleId) || activeModule} />
          </div>
        </div>

        {!locked && <ToolApprovalDialog />}

        {/* 待发提醒中心（⏰ 入口在 Sidebar） */}
        {!locked && remindersOpen && <RemindersModal onClose={() => setRemindersOpen(false)} />}

        {/* 全局命令面板（Ctrl/⌘+P；锁屏不挂载，中枢亦拦截快捷键） */}
        {!locked && <CommandPalette />}

        {/* 应用内划词浮条（选区助手；锁屏不挂载，杜绝敏感内容外泄） */}
        {!locked && <SelectionToolbar />}

        {!locked && wizard && (
          <FirstRunWizard variant={wizard} onClose={() => setWizard(null)} />
        )}

        {locked && (
          <LockOverlay
            dbEncrypted={dbEncrypted}
            pwd={lockPwd}
            onPwdChange={setLockPwd}
            error={lockErr}
            onUnlock={handleUnlock}
          />
        )}
      </div>
    </ToastProvider>
  )
}
