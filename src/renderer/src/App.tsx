import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar, type ModuleId } from './components/Sidebar'
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
import { hasIpcFailed, reportIpcError, ipcFailText } from './utils/ipc'
import { createEncryptionFlagSyncer } from './utils/lock-flags'
import { ShowingDefaultsNotice } from './components/ShowingDefaultsNotice'
import { startLongTaskObserver } from './utils/longtask'
import { useAppStore } from './store/app-store'
import { getChatFontLoadError } from './chat-font'
import { getCodeCollapseLoadError } from './code-collapse'
import { getCustomCssLoadError } from './custom-css'

export default function App() {
  const { t } = useI18n()

  // 跨模块状态从全局 store 读取
  const activeModule = useAppStore((s) => s.activeModule)
  const locked = useAppStore((s) => s.locked)
  const dbEncrypted = useAppStore((s) => s.dbEncrypted)
  const wizard = useAppStore((s) => s.wizard)

  const switchModule = useAppStore((s) => s.switchModule)
  const touchModule = useAppStore((s) => s.touchModule)
  const setLocked = useAppStore((s) => s.setLocked)
  const setDbEncrypted = useAppStore((s) => s.setDbEncrypted)
  const setWizard = useAppStore((s) => s.setWizard)

  // 仅 UI 本地状态：锁屏密码输入
  const [collapsed, setCollapsed] = useState(false)
  // 待发提醒中心（仅主窗口；独立窗口/浮窗不挂）
  const [remindersOpen, setRemindersOpen] = useState(false)
  const [lockPwd, setLockPwd] = useState('')
  const [lockErr, setLockErr] = useState('')
  // 挂载那两发读的失败原因（V4-Iter-250）：读不到 ≠ "没加密、没锁"，得在屏上说得出
  const [encReadErr, setEncReadErr] = useState<string | null>(null)
  const [lockReadErr, setLockReadErr] = useState<string | null>(null)
  // §278：启动时那三发 UI 偏好读（字体／折叠／自定义 CSS）失败时不许把"读不到"演成"没设过"
  const [chatFontUnread, setChatFontUnread] = useState<string | null>(null)
  const [codeCollapseUnread, setCodeCollapseUnread] = useState<string | null>(null)
  const [customCssUnread, setCustomCssUnread] = useState<string | null>(null)

  const contentRef = useRef<HTMLDivElement>(null)

  // 模块切换：更新保活 LRU（挂载新模块、超阈值时休眠最久未访问者）
  useEffect(() => {
    touchModule(activeModule)
  }, [activeModule, touchModule])

  // 渲染层长任务观测（实测定位界面卡顿；不支持的环境静默跳过）
  useEffect(() => {
    startLongTaskObserver()
  }, [])

  // §278：启动时那三发 UI 偏好读（字体／折叠／自定义 CSS）失败时要在屏上说得出
  // main.tsx 顶层已经读过一次并应用到 DOM，这里只读模块记录的失败状态，不重复拉 IPC
  useEffect(() => {
    const chatErr = getChatFontLoadError()
    const collapseErr = getCodeCollapseLoadError()
    const cssErr = getCustomCssLoadError()
    setChatFontUnread(chatErr)
    setCodeCollapseUnread(collapseErr)
    setCustomCssUnread(cssErr)
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
    // 这两发读只在挂载时跑一次、没有重试路径 ⇒ 失败不能只进 console：
    // 默认值是 dbEncrypted=false／locked=false，静默失败＝界面把"读不到"演成"没加密、没锁"。
    // 加密态还得在每次锁屏事件到达时重读（§342）：挂载那次读到的副本会漂——
    // 向导里设完主密码、设置页关掉加密，主进程 mode 当场变了，遮罩却还按旧值渲染。
    const syncEnc = createEncryptionFlagSyncer({ setDbEncrypted, setEncReadErr, t })
    void syncEnc().catch(reportIpcError('app.getEncryptionStatus'))
    window.pocketai
      .getLockStatus()
      .then((s) => {
        if (hasIpcFailed(s)) {
          setLockReadErr(ipcFailText(s, t('common.unknownError')))
          return
        }
        setLockReadErr(null)
        setLocked(s.state === 'locked')
      })
      .catch(reportIpcError('app.getLockStatus'))
    const off = window.pocketai.onLockStateChange((e) => {
      setLockReadErr(null)
      setLocked(e.state === 'locked')
      setLockPwd('')
      setLockErr('')
      void syncEnc().catch(reportIpcError('app.getEncryptionStatus'))
    })
    return off
  }, [setDbEncrypted, setLocked, t])

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

  // 应用内全局快捷键中枢（Ctrl+数字切侧栏第 N 个模块 / Ctrl+, 设置 / Ctrl+L 锁屏 / 会话类）
  useGlobalShortcuts()

  const handleModuleChange = useCallback(
    (id: ModuleId) => {
      switchModule(id)
    },
    [switchModule]
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
          {/* 侧栏即唯一导航：模块内容区直接顶到窗口顶部（原 36px 标签栏已随标签页系统下线） */}
          <div className="flex flex-col flex-1 min-w-0">
            {(encReadErr || lockReadErr || chatFontUnread || codeCollapseUnread || customCssUnread) && (
              <div className="px-3 pt-2 space-y-1">
                {encReadErr && <ShowingDefaultsNotice what={t('enc.dbEnc')} msg={encReadErr} />}
                {lockReadErr && <ShowingDefaultsNotice what={t('enc.lockState')} msg={lockReadErr} />}
                {chatFontUnread && <ShowingDefaultsNotice what={t('ui.fontSize')} msg={chatFontUnread} />}
                {codeCollapseUnread && <ShowingDefaultsNotice what={t('ui.codeCollapse')} msg={codeCollapseUnread} />}
                {customCssUnread && <ShowingDefaultsNotice what={t('ui.customCss')} msg={customCssUnread} />}
              </div>
            )}
            <Workspace activeModule={activeModule} />
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
