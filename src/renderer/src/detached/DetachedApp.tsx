// 独立窗口：#/detached?module=xxx —— 单模块全屏（无侧边栏/TabBar），锁屏联动与主窗口一致
import React, { useEffect, useRef, useState } from 'react'
import { Workspace } from '../components/Workspace'
import { ToastProvider } from '../components/ToastProvider'
import type { ModuleId } from '../components/Sidebar'
import { useI18n } from '../i18n'

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
    window.pocketai.getEncryptionStatus().then((s) => setDbEncrypted(s.dbEncrypted)).catch(() => {})
    window.pocketai.getLockStatus().then((s) => setLocked(s.state === 'locked')).catch(() => {})
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

  // 手动锁屏快捷键：Ctrl/Cmd + L（与主窗口一致）
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

  // 窗口标题 = 模块名
  useEffect(() => {
    const key = MODULE_TITLES[moduleId]
    if (key) document.title = t(key)
  }, [moduleId, t])

  async function handleUnlock() {
    setLockErr('')
    const res = await window.pocketai.unlock(dbEncrypted ? lockPwd : undefined)
    if (!res.ok) setLockErr(res.error ?? '解锁失败')
  }

  return (
    <ToastProvider>
      <div
        ref={contentRef}
        className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]"
      >
        <Workspace moduleId={moduleId} />

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
