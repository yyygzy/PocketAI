// 独立窗口：#/detached?module=xxx —— 单模块全屏（无侧边栏/TabBar），锁屏联动与主窗口一致
import React, { useEffect, useRef, useState } from 'react'
import { Workspace } from '../components/Workspace'
import { ToastProvider } from '../components/ToastProvider'
import { SelectionToolbar } from '../components/SelectionToolbar'
import { LockOverlay } from '../components/LockOverlay'
import type { ModuleId } from '../components/Sidebar'
import { useI18n } from '../i18n'
import { reportIpcError } from '../utils/ipc'
import { matchAppShortcut, filterShortcutForContext, type ConversationShortcutAction } from '../utils/shortcuts'
import { APP_SHORTCUT_EVENT, type AppShortcutEventDetail } from '../hooks/useGlobalShortcuts'

const MODULE_TITLES: Record<ModuleId, string> = {
  chat: 'tab.newChat',
  agent: 'tab.newAgent',
  skills: 'tab.skills',
  knowledge: 'tab.knowledge',
  files: 'tab.files',
  notes: 'tab.notes',
  translate: 'tab.translate',
  image: 'tab.image',
  sandbox: 'tab.sandbox',
  terminal: 'tab.terminal',
  steward: 'tab.steward',
  settings: 'tab.settings'
}

export const DetachedApp: React.FC<{ moduleId: ModuleId }> = ({ moduleId }) => {
  const { t } = useI18n()
  const [locked, setLocked] = useState(false)
  const [dbEncrypted, setDbEncrypted] = useState(false)
  const [lockPwd, setLockPwd] = useState('')
  const [lockErr, setLockErr] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)

  // 锁屏状态与主窗口联动（锁屏事件广播到所有窗口）
  useEffect(() => {
    window.pocketai.getEncryptionStatus().then((s) => setDbEncrypted(s.dbEncrypted)).catch(reportIpcError('detached.getEncryptionStatus'))
    window.pocketai.getLockStatus().then((s) => setLocked(s.state === 'locked')).catch(reportIpcError('detached.getLockStatus'))
    return window.pocketai.onLockStateChange((e) => {
      setLocked(e.state === 'locked')
      setLockPwd('')
      setLockErr('')
    })
  }, [])

  // 锁屏加固：inert 掉遮罩之外的全部内容（与主窗口同策略）
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (locked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [locked])

  // 用户活跃上报（自动锁屏计时需要所有窗口参与）
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

  // 应用内快捷键中枢：lock / 会话类四动作（newConv / focusSearch / focusComposer / abort）
  // Workspace 内的 ChatModule / AgentPanel 已监听 APP_SHORTCUT_EVENT 且守卫可通过
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const m = matchAppShortcut(e, { running: false })
      if (!m) return
      const filtered = filterShortcutForContext(m, 'detached')
      if (!filtered) return
      e.preventDefault()
      if (filtered.id === 'lock') {
        window.pocketai.lock().catch(reportIpcError('detached.lock'))
        return
      }
      const detail: AppShortcutEventDetail = { action: filtered.id as ConversationShortcutAction }
      window.dispatchEvent(new CustomEvent<AppShortcutEventDetail>(APP_SHORTCUT_EVENT, { detail }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 窗口标题 = 模块名
  useEffect(() => {
    const key = MODULE_TITLES[moduleId]
    if (key) document.title = t(key)
  }, [moduleId, t])

  async function handleUnlock() {
    setLockErr('')
    const res = await window.pocketai.unlock(dbEncrypted ? lockPwd : undefined)
    if (!res.ok) setLockErr(res.error ?? t('lock.unlockFailed'))
  }

  return (
    <ToastProvider>
      <div
        ref={contentRef}
        className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]"
      >
        <Workspace activeModule={moduleId} />
        {!locked && <SelectionToolbar />}

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
