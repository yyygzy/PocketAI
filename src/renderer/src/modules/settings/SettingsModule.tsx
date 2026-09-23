import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppPaths,
  EncryptionStatus,
  BackupScheduleStatus,
  LicenseStatus,
  PopupConfig,
  UpdateInfo,
  UpdateEvent,
  WebDAVConfig,
  WebDAVBackupFile
} from '../../../../shared/types'
import { ProviderSettings, Notice } from './ProviderSettings'
import { OllamaPanel } from '../../components/OllamaPanel'
import { useI18n } from '../../i18n'
import { injectCustomCss } from '../../custom-css'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { useTransientNotice } from '../../hooks/useTransientNotice'
import { logIpcError, reportIpcError } from '../../utils/ipc'

/** 从 unknown 异常中取 message；非 Error 或无消息时回退 fallback */
function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export const SettingsModule: React.FC = () => {
  const { t } = useI18n()
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [enc, setEnc] = useState<EncryptionStatus | null>(null)
  const [lic, setLic] = useState<LicenseStatus | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateEvent>({ status: 'idle' })

  useEffect(() => {
    window.pocketai.getPaths().then(setPaths).catch(reportIpcError('settings.getPaths'))
    window.pocketai.getEncryptionStatus().then(setEnc).catch(reportIpcError('settings.getEncryptionStatus'))
    window.pocketai.getLicenseStatus().then(setLic).catch(reportIpcError('settings.getLicenseStatus'))
    window.pocketai.getUpdateInfo().then(setUpdateInfo).catch(reportIpcError('settings.getUpdateInfo'))
    // 监听主进程推送的更新状态事件
    const unsub = window.pocketai.onUpdateEvent((data) => {
      setUpdateStatus(data)
    })
    // 锁屏遮罩不卸载本模块：解锁后 masterPasswordVerified 会变化，需重新拉取
    const offLock = window.pocketai.onLockStateChange(() => {
      window.pocketai.getEncryptionStatus().then(setEnc).catch(reportIpcError('settings.onUnlock.getEncryptionStatus'))
    })
    return () => { unsub(); offLock() }
  }, [])

  const refreshEnc = () => window.pocketai.getEncryptionStatus().then(setEnc).catch(reportIpcError('settings.refreshEnc'))

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        <ProviderSettings />

        <div className="mt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.localModel')}</h3>
          <OllamaPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.encryption')}</h3>
          <EncryptionPanel enc={enc} onChange={refreshEnc} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.backup')}</h3>
          <BackupPanel enc={enc} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.update')}</h3>
          <UpdatePanel info={updateInfo} status={updateStatus} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.popup')}</h3>
          <PopupPanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.appearance')}</h3>
          <AppearancePanel />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.license')}</h3>
          <LicensePanel lic={lic} onChange={() => window.pocketai.getLicenseStatus().then(setLic).catch(reportIpcError('license.refreshStatus'))} />
        </div>
      </div>

      {paths && (
        <div className="shrink-0 border-t border-[var(--color-border)] pt-3 mt-3">
          <h3 className="text-xs font-semibold text-[var(--color-text-muted)] mb-2">{t('set.paths')}</h3>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
            <PathRow label={t('set.dataDir')} value={paths.dataDir} />
            <PathRow label={t('set.dbPath')} value={paths.dbPath} />
            <PathRow label={t('set.attachments')} value={paths.attachmentsDir} />
            <PathRow label={t('set.extensions')} value={paths.extensionsDir} />
          </div>
        </div>
      )}
    </div>
  )
}

const PathRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-2">
    <span className="text-[var(--color-text-muted)] shrink-0">{label}</span>
    <span className="font-mono truncate" title={value}>
      {value}
    </span>
  </div>
)

// ─── Modal 弹层（统一弹层）─────────────────────────────────────

const Modal: React.FC<{ open: boolean; title: string; onClose: () => void; children: React.ReactNode; width?: number }> = ({ open, title, onClose, children, width = 360 }) => {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm" onClick={onClose}>
      <div
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl p-5"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">{title}</h4>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] text-lg leading-none" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ─── 加密面板 ───────────────────────────────────────────────────

const EncryptionPanel: React.FC<{ enc: EncryptionStatus | null; onChange: () => void }> = ({ enc, onChange }) => {
  const { t } = useI18n()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  if (!enc) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const encrypted = enc.dbEncrypted
  const unlocked = enc.unlocked

  return (
    <div className="space-y-3">
      <StatusRow label={t('enc.dbEnc')} value={encrypted ? t('enc.enabled') : t('enc.disabled')} ok={encrypted} />
      <StatusRow label={t('enc.status')} value={unlocked ? t('enc.unlocked') : t('enc.locked')} ok={unlocked} />
      <StatusRow label={t('enc.field')} value={t('enc.fieldValue')} ok />

      <AutoLockRow />

      <div className="flex flex-wrap gap-2 pt-1">
        {!encrypted && <EnableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <ChangePasswordBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <DisableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && !unlocked && <LockBtn onDone={onChange} />}
      </div>

      {encrypted && unlocked && <RecoveryKeyCard setNotice={setNotice} />}

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
        {t('enc.hint')}
      </p>
    </div>
  )
}

const StatusRow: React.FC<{ label: string; value: string; ok?: boolean }> = ({ label, value, ok }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]'}`} />
    <span className="text-[var(--color-text-muted)] w-16">{label}</span>
    <span className={ok ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]'}>{value}</span>
  </div>
)

// 自动锁屏超时选项（ms）；0=永不
const AUTO_LOCK_OPTIONS = [0, 60_000, 300_000, 900_000, 1_800_000, 3_600_000]

const AutoLockRow: React.FC = () => {
  const { t } = useI18n()
  const [value, setValue] = useState<number | null>(null)
  const { notice: saved, show: markSaved, clear: clearSaved } = useTransientNotice<boolean>(1500)

  useEffect(() => {
    window.pocketai
      .getLockStatus()
      .then((s) => setValue(s.autoLockTimeout ?? 0))
      .catch(() => setValue(0))
  }, [])

  const label = (ms: number) =>
    ms === 0 ? t('enc.autoLockNever') : ms === 3_600_000 ? t('enc.autoLockHour') : t('enc.autoLockMin', { n: Math.round(ms / 60_000) })

  async function change(ms: number) {
    setValue(ms)
    clearSaved()
    try {
      const r = await window.pocketai.setAutoLockTimeout(ms)
      if (r?.ok) {
        markSaved(true)
      }
    } catch {
      /* 保持所选值，下次打开设置页会回读真实状态 */
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[var(--color-text-muted)] w-16">{t('enc.autoLock')}</span>
        <select
          className="input py-1 text-xs w-32"
          value={value ?? 0}
          disabled={value === null}
          onChange={(e) => change(Number(e.target.value))}
        >
          {AUTO_LOCK_OPTIONS.map((ms) => (
            <option key={ms} value={ms}>
              {label(ms)}
            </option>
          ))}
        </select>
        {saved && <span className="text-[11px] text-[var(--color-success)]">{t('enc.autoLockSaved')}</span>}
      </div>
      <div className="text-[11px] text-[var(--color-text-muted)] pl-[4.5rem]">{t('enc.autoLockDesc')}</div>
    </div>
  )
}

type NoticeFn = (n: { ok: boolean; text: string } | null) => void

// ─── 加密操作按钮 ───────────────────────────────────────────────

const EnableEncryptionBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pwd, setPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')

  async function submit() {
    setLocalErr('')
    if (pwd.length < 6) return setLocalErr(t('enc.pwdShort'))
    if (pwd !== confirm) return setLocalErr(t('enc.pwdMismatch'))
    setBusy(true)
    try {
      const r = await window.pocketai.enableEncryption(pwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.enableFail')); return }
      setOpen(false); setPwd(''); setConfirm('')
      setNotice({ ok: true, text: t('enc.enabledOk') })
      onDone()
    } catch (e) {
      setLocalErr(errMsg(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}>{t('enc.enableBtn')}</button>
      <Modal open={open} title={t('enc.setPwdTitle')} onClose={() => !busy && setOpen(false)}>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          {t('enc.setPwdDesc')}<br />
          <span className="text-[var(--color-warning)]">{t('enc.setPwdWarn')}</span>
        </p>
        <Field label={t('enc.pwd')}>
          <input className="input" type="password" placeholder={t('enc.pwdPh')} value={pwd} onChange={e => setPwd(e.target.value)} autoFocus />
        </Field>
        <Field label={t('enc.confirm')}>
          <input className="input" type="password" placeholder={t('enc.confirmPh')} value={confirm} onChange={e => setConfirm(e.target.value)} />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? t('common.processing') : t('common.confirm')}</button>
        </div>
      </Modal>
    </>
  )
}

const ChangePasswordBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')
  const [rotatedCode, setRotatedCode] = useState('')

  async function submit() {
    setLocalErr('')
    if (newPwd.length < 6) return setLocalErr(t('enc.newShort'))
    if (newPwd !== confirm) return setLocalErr(t('enc.pwdMismatch'))
    if (oldPwd === newPwd) return setLocalErr(t('enc.oldNewSame'))
    setBusy(true)
    try {
      const r = await window.pocketai.changePassword(oldPwd, newPwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.oldWrong')); return }
      setOpen(false); setOldPwd(''); setNewPwd(''); setConfirm('')
      setNotice({ ok: true, text: t('enc.pwdUpdated') })
      onDone()  // ✅ 刷新加密状态
      // 之前生成过恢复码：rekey 后旧码失效，必须让用户保存新码
      if (r.recoveryCode) setRotatedCode(r.recoveryCode)
    } catch (e) {
      setLocalErr(errMsg(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-ghost" onClick={() => setOpen(true)}>{t('enc.changePwd')}</button>
      <Modal open={open} title={t('enc.changeTitle')} onClose={() => !busy && setOpen(false)}>
        <Field label={t('enc.currentPwd')}>
          <input className="input" type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} autoFocus />
        </Field>
        <Field label={t('enc.newPwd')}>
          <input className="input" type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} />
        </Field>
        <Field label={t('enc.confirmNew')}>
          <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? t('common.processing') : t('common.confirm')}</button>
        </div>
      </Modal>
      {rotatedCode && (
        <RecoveryCodeModal
          code={rotatedCode}
          title={t('enc.recoveryRotatedTitle')}
          onClose={() => setRotatedCode('')}
        />
      )}
    </>
  )
}

const DisableEncryptionBtn: React.FC<{ onDone: () => void; setNotice: NoticeFn }> = ({ onDone, setNotice }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [localErr, setLocalErr] = useState('')

  async function submit() {
    setLocalErr('')
    if (!pwd) return setLocalErr(t('enc.enterCurrent'))
    setBusy(true)
    try {
      const r = await window.pocketai.disableEncryption(pwd)
      if (!r.ok) { setLocalErr(r.error ?? t('enc.pwdWrong')); return }
      setOpen(false); setPwd('')
      setNotice({ ok: true, text: t('enc.disabledOk') })
      onDone()
    } catch (e) {
      setLocalErr(errMsg(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="btn-ghost text-[var(--color-danger)] hover:opacity-80" onClick={() => setOpen(true)}>{t('enc.disable')}</button>
      <Modal open={open} title={t('enc.disableTitle')} onClose={() => !busy && setOpen(false)}>
        <p className="text-xs text-[var(--color-text-muted)] mb-3">
          {t('enc.disableDesc')}
        </p>
        <Field label={t('enc.currentPwd')}>
          <input className="input" type="password" value={pwd} onChange={e => setPwd(e.target.value)} autoFocus />
        </Field>
        {localErr && <div className="text-xs text-[var(--color-danger)] mb-2">{localErr}</div>}
        <div className="flex gap-2 justify-end pt-2">
          <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button className="btn-primary bg-[var(--color-danger)] hover:opacity-90" disabled={busy} onClick={submit}>
            {busy ? t('common.processing') : t('enc.confirmDisable')}
          </button>
        </div>
      </Modal>
    </>
  )
}

const LockBtn: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { t } = useI18n()
  async function lock() {
    await window.pocketai.lockEncryption()
    onDone()
  }
  return <button className="btn-ghost" onClick={lock}>{t('enc.lock')}</button>
}

// ─── 恢复密钥 ───────────────────────────────────────────────────

/** 恢复码一次性展示弹窗：复制 / 另存文件 / 确认已保存 */
const RecoveryCodeModal: React.FC<{ code: string; title: string; onClose: () => void }> = ({
  code,
  title,
  onClose
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  return (
    <Modal open title={title} onClose={onClose}>
      <p className="text-xs text-[var(--color-warning)] mb-2">{t('enc.recoveryShowOnce')}</p>
      <textarea
        readOnly
        rows={3}
        value={code}
        onFocus={(e) => e.currentTarget.select()}
        className="input font-mono text-sm tracking-wider resize-none"
      />
      <div className="flex gap-2 my-3">
        <button
          className="btn-ghost"
          onClick={async () => {
            try {
              await window.pocketai.copySensitiveToClipboard(code)
              setCopied(true)
              setCopyFailed(false)
            } catch {
              // 恢复码复制失败必须提示：误以为已复制会导致无法找回数据
              setCopyFailed(true)
            }
          }}
        >
          {t('enc.recoveryCopy')}
        </button>
        <button className="btn-ghost" onClick={() => window.pocketai.saveRecoveryFile(code)}>
          {t('enc.recoverySaveFile')}
        </button>
      </div>
      {copied && (
        <p className="text-[11px] text-[var(--color-text-muted)] mb-2">
          {t('enc.clipboardAutoClear', { s: 30 })}
        </p>
      )}
      {copyFailed && (
        <p className="text-[11px] text-[var(--color-danger)] mb-2">{t('common.copyFailed')}</p>
      )}
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mb-3">
        {t('enc.recoveryModalWarn')}
      </p>
      <div className="flex justify-end">
        <button className="btn-primary" onClick={onClose}>{t('enc.recoverySaved')}</button>
      </div>
    </Modal>
  )
}

const RecoveryKeyCard: React.FC<{ setNotice: NoticeFn }> = ({ setNotice }) => {
  const { t } = useI18n()
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [shownCode, setShownCode] = useState('')

  const refresh = useCallback(() => window.pocketai.hasRecoveryKey().then(setHasKey).catch(reportIpcError('settings.hasRecoveryKey')), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  async function generate() {
    // 已有恢复码时重新生成会作废旧码，二次确认
    if (hasKey && !window.confirm(t('enc.recoveryRegenConfirm'))) return
    setBusy(true)
    try {
      const r = await window.pocketai.generateRecoveryKey()
      if (!r.ok || !r.code) {
        setNotice({ ok: false, text: r.error ?? t('enc.recoveryGenFail') })
        return
      }
      setShownCode(r.code)
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(t('enc.recoveryRemoveConfirm'))) return
    await window.pocketai.disableRecoveryKey()
    void refresh()
    setNotice({ ok: true, text: t('enc.recoveryRemoved') })
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 mt-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-[var(--color-text)]">{t('enc.recoveryTitle')}</div>
          <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            {hasKey ? t('enc.recoverySet') : t('enc.recoveryNotSet')}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          <button className="btn-ghost" disabled={busy} onClick={generate}>
            {hasKey ? t('enc.recoveryRegen') : t('enc.recoveryGenerate')}
          </button>
          {hasKey && (
            <button
              className="btn-ghost text-[var(--color-danger)] hover:opacity-80"
              disabled={busy}
              onClick={remove}
            >
              {t('enc.recoveryRemove')}
            </button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-2">
        {t('enc.recoveryDesc')}
      </p>
      {shownCode && (
        <RecoveryCodeModal
          code={shownCode}
          title={t('enc.recoveryModalTitle')}
          onClose={() => setShownCode('')}
        />
      )}
    </div>
  )
}

// ─── 备份面板 ────────────────────────────────────────────────────

const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168]

const BackupPanel: React.FC<{ enc: EncryptionStatus | null }> = ({ enc }) => {
  const { t, lang } = useI18n()
  // 加密备份唯一闸门是主进程 masterKeyManager.getDbKey()：
  // 仅 db 模式且已解锁（主密码已验证）时可用；none 模式与锁屏期间禁用
  const encrypted = !!enc?.dbEncrypted && !!enc?.masterPasswordVerified
  const [cfg, setCfg] = useState<WebDAVConfig | null>(null)
  const [schedule, setSchedule] = useState<BackupScheduleStatus | null>(null)
  const [webdavList, setWebdavList] = useState<WebDAVBackupFile[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [wdUrl, setWdUrl] = useState('')
  const [wdUser, setWdUser] = useState('')
  const [wdPwd, setWdPwd] = useState('')
  const [wdDir, setWdDir] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.pocketai.loadWebDAVConfig().then((c) => {
      if (c) {
        setCfg(c)
        setWdUrl(c.url); setWdUser(c.username); setWdDir(c.directory || '')
      }
    }).catch(reportIpcError('settings.loadWebDAVConfig'))
    window.pocketai.getBackupSchedule().then(setSchedule).catch(reportIpcError('settings.refreshSchedule')).catch(reportIpcError('settings.getBackupSchedule'))
  }, [])

  const intervalLabel = (h: number): string => {
    if (lang === 'en') {
      return h === 24 ? 'Daily' : h === 48 ? 'Every 2 days' : h === 72 ? 'Every 3 days' : h === 168 ? 'Weekly' : `Every ${h} hours`
    }
    return h === 24 ? '每天' : h === 48 ? '每 2 天' : h === 72 ? '每 3 天' : h === 168 ? '每周' : `每 ${h} 小时`
  }

  async function saveSchedule(patch: { enabled?: boolean; intervalHours?: number }) {
    const next = await window.pocketai.setBackupSchedule(patch)
    setSchedule(next)
  }

  const showNotice = (ok: boolean, text: string) => setNotice({ ok, text })

  async function saveWD() {
    if (!wdUrl || !wdUser) return showNotice(false, t('bk.urlUserRequired'))
    const c: WebDAVConfig = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
    await window.pocketai.saveWebDAVConfig(c)
    setCfg(c); showNotice(true, t('bk.cfgSaved'))
  }

  async function testWD() {
    const c: WebDAVConfig = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
    showNotice(true, t('bk.connecting'))
    const r = await window.pocketai.testWebDAV(c)
    showNotice(r.ok, r.ok ? t('bk.connOk') : t('bk.connFail', { e: r.message ?? t('common.unknownError') }))
  }

  async function doLocalBackup() {
    showNotice(true, t('bk.packing'))
    const r = await window.pocketai.createLocalBackup()
    showNotice(true, t('bk.localDone', { size: (r.size / 1024).toFixed(1) }))
  }
  async function doEncBackup() {
    if (!encrypted) return // 未启用主密码时按钮禁用，双保险
    showNotice(true, t('bk.encDoing'))
    const r = await window.pocketai.createEncryptedLocalBackup()
    if (r.ok === false) {
      showNotice(false, r.error || t('common.unknownError'))
      return
    }
    showNotice(true, t('bk.encDone', { size: (r.size / 1024).toFixed(1) }))
  }

  async function doUpload() {
    showNotice(true, t('bk.uploading'))
    const r = await window.pocketai.uploadWebDAVBackup()
    if (r.ok === false) { showNotice(false, t('bk.uploadFail', { e: r.error ?? t('common.unknownError') })); return }
    showNotice(true, t('bk.uploaded', { name: r.filename ?? '' }))
    await refreshList()
    window.pocketai.getBackupSchedule().then(setSchedule).catch(reportIpcError('settings.refreshSchedule'))
  }

  async function doIncrementalUpload() {
    showNotice(true, t('bk.uploading'))
    const r = await window.pocketai.uploadIncrementalBackup()
    if (r.ok === false) {
      showNotice(false, t('bk.uploadFail', { e: r.error ?? t('common.unknownError') }))
      return
    }
    showNotice(
      true,
      t('bk.incDone', {
        total: r.attachmentsTotal,
        uploaded: r.blobsUploaded,
        skipped: r.blobsSkipped,
        kb: (r.bytesUploaded / 1024).toFixed(1)
      })
    )
    await refreshList()
    window.pocketai.getBackupSchedule().then(setSchedule).catch(reportIpcError('settings.refreshSchedule'))
  }

  async function refreshList() {
    setListLoading(true)
    try {
      const items = await window.pocketai.listWebDAVBackups()
      setWebdavList(items)
    } catch {
      setNotice({ ok: false, text: t('bk.listFail') })
    } finally {
      setListLoading(false)
    }
  }

  async function doRestore(filename: string) {
    if (!window.confirm(t('bk.restoreConfirm', { name: filename }))) return
    showNotice(true, t('bk.downloadingRestore'))
    const r = await window.pocketai.restoreWebDAVBackup(filename)
    showNotice(r.ok, r.ok ? t('bk.restoreOk') : t('bk.restoreFail', { e: r.error ?? t('common.unknownError') }))
  }

  async function doDelete(filename: string) {
    if (!window.confirm(t('bk.deleteConfirm', { name: filename }))) return
    await window.pocketai.deleteWebDAVBackup(filename)
    await refreshList()
    showNotice(true, t('bk.deleted'))
  }

  return (
    <div className="space-y-4">
      {/* WebDAV 配置 */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.webdavTitle')}</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="URL"><input className="input" placeholder="https://dav.example.com/..." value={wdUrl} onChange={e => setWdUrl(e.target.value)} /></Field>
          <Field label={t('bk.user')}><input className="input" value={wdUser} onChange={e => setWdUser(e.target.value)} /></Field>
          <Field label={t('bk.password')}><input className="input" type="password" value={wdPwd} onChange={e => setWdPwd(e.target.value)} /></Field>
          <Field label={t('bk.dir')}><input className="input" placeholder="/backups" value={wdDir} onChange={e => setWdDir(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2 mt-2">
          <button className="btn-ghost" onClick={saveWD}>{t('bk.saveCfg')}</button>
          <button className="btn-ghost" onClick={testWD}>{t('bk.testConn')}</button>
        </div>
      </div>

      {/* 定时备份（需先保存 WebDAV 配置） */}
      {cfg && schedule && (
        <div className="rounded-lg border border-[var(--color-border)] p-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--color-accent)]"
              checked={schedule.enabled}
              onChange={(e) => saveSchedule({ enabled: e.target.checked })}
            />
            <span className="text-sm">{t('bk.scheduleEnable')}</span>
          </label>
          {schedule.enabled && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)]">{t('bk.scheduleInterval')}</span>
                <select
                  className="input py-1 text-xs w-32"
                  value={schedule.intervalHours}
                  onChange={(e) => saveSchedule({ intervalHours: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.map((h) => (
                    <option key={h} value={h}>{intervalLabel(h)}</option>
                  ))}
                </select>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {schedule.lastResult?.ok
                  ? t('bk.scheduleLastOk', { time: new Date(schedule.lastResult.at).toLocaleString() })
                  : schedule.lastResult
                    ? t('bk.scheduleLastFail', { time: new Date(schedule.lastResult.at).toLocaleString(), e: schedule.lastResult.error ?? '' })
                    : t('bk.scheduleNever')}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{t('bk.scheduleHint')}</div>
            </div>
          )}
        </div>
      )}

      {/* 本地备份 */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.localTitle')}</div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={doLocalBackup}>{t('bk.localBtn')}</button>
          <button
            className="btn-ghost"
            onClick={doEncBackup}
            disabled={!encrypted}
            title={encrypted ? undefined : t('bk.encNeedMaster')}
          >{t('bk.encBtn')}</button>
        </div>
        {!encrypted && (
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1.5">{t('bk.encNeedMaster')}</div>
        )}
      </div>

      {/* WebDAV 操作 */}
      {cfg && (
        <div>
          <div className="flex gap-2 mb-2">
            <button className="btn-primary" onClick={doUpload}>{t('bk.uploadBtn')}</button>
            <button className="btn-ghost" onClick={doIncrementalUpload}>{t('bk.incBtn')}</button>
            <button className="btn-ghost" onClick={refreshList} disabled={listLoading}>
              {listLoading ? `⏳ ${t('common.loading')}` : t('bk.refresh')}
            </button>
          </div>
          <p className="text-[10px] text-[var(--color-text-muted)] mb-2">{t('bk.incHint')}</p>

          {listLoading ? (
            <div className="text-xs text-[var(--color-text-muted)]">{t('bk.listLoading')}</div>
          ) : webdavList.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)]">{t('bk.listEmpty')}</div>
          ) : (
            <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)]">
                    <th className="text-left px-3 py-2 font-medium">{t('bk.fileName')}</th>
                    <th className="px-3 py-2 font-medium w-20">{t('bk.size')}</th>
                    <th className="px-3 py-2 font-medium w-36">{t('bk.time')}</th>
                    <th className="px-3 py-2 font-medium w-24"></th>
                  </tr>
                </thead>
                <tbody>
                  {webdavList.map((f) => (
                    <tr key={f.name} className="border-t border-[var(--color-border)]/40 hover:bg-[var(--color-hover-overlay)]">
                      <td className="px-3 py-1.5 font-mono truncate max-w-[240px]" title={f.name}>
                        {f.encrypted && <span className="text-[var(--color-warning)] mr-1">🔒</span>}
                        {f.kind === 'incremental' && (
                          <span
                            className="mr-1 px-1 py-0.5 text-[9px] rounded border border-[var(--color-accent)] text-[var(--color-accent)] align-middle"
                            title={t('bk.incBadgeTip')}
                          >
                            {t('bk.incBadge')}
                          </span>
                        )}
                        {f.name}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{(f.size / 1024).toFixed(1)} KB</td>
                      <td className="px-3 py-1.5 text-[var(--color-text-muted)]">{new Date(f.mtime).toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right">
                        <button className="btn-ghost text-xs px-2 py-0.5 mr-1" onClick={() => doRestore(f.name)}>{t('bk.restore')}</button>
                        <button className="btn-ghost text-[var(--color-danger)] hover:opacity-80 text-xs px-2 py-0.5" onClick={() => doDelete(f.name)}>{t('common.delete')}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}
    </div>
  )
}

// ─── Field 组件（和 ProviderSettings 共用）──────────────────────

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs text-[var(--color-text-muted)] mb-1">{label}</label>
    {children}
  </div>
)

// ─── License 面板 ────────────────────────────────────────────────

const LicensePanel: React.FC<{ lic: LicenseStatus | null; onChange: () => void }> = ({ lic, onChange }) => {
  const { t, lang } = useI18n()
  const locale = lang === 'en' ? 'en-US' : 'zh-CN'
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 粘贴激活码模式（license.lic JSON 文本）：文件选择之外的另一激活入口
  const [pasteOpen, setPasteOpen] = useState(false)
  const [codeText, setCodeText] = useState('')
  // 卡密在线激活：卡密 + 服务器校验后下发绑定本机硬盘的 license
  const [onlineCode, setOnlineCode] = useState('')
  // 本机硬盘指纹：在线激活自动附带；离线激活时发给卖家签发绑定 license
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  // 指纹复制反馈（2s；含剪贴板降级与定时器清理）
  const { copied: fpCopied, copy: copyFingerprint } = useCopyFeedback(2000)
  // 离线激活折叠区
  const [offlineOpen, setOfflineOpen] = useState(false)

  useEffect(() => {
    window.pocketai.getLicenseFingerprint().then(setFingerprint).catch((e) => {
      logIpcError('license.getFingerprint', e)
      setFingerprint(null)
    })
  }, [])

  if (!lic) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const handleActivate = () => fileRef.current?.click()

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow same file re-select
    if (!file) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.loadLicenseString(await file.text())
      if (!r.valid) { setNotice({ ok: false, text: r.error ?? t('lic.activateFail') }); return }
      setNotice({ ok: true, text: t('lic.activated', { owner: r.payload?.owner ?? '', plan: r.payload?.plan ?? '' }) })
      onChange()
    } catch (e) {
      setNotice({ ok: false, text: errMsg(e, t('lic.activateFail')) })
    } finally { setBusy(false) }
  }

  const handleClear = async () => {
    if (!window.confirm(t('lic.clearConfirm'))) return
    await window.pocketai.clearLicense()
    setNotice({ ok: true, text: t('lic.cleared') })
    onChange()
  }

  const handlePasteActivate = async () => {
    if (!codeText.trim()) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.loadLicenseString(codeText)
      if (!r.valid) { setNotice({ ok: false, text: r.error ?? t('lic.activateFail') }); return }
      setNotice({ ok: true, text: t('lic.activated', { owner: r.payload?.owner ?? '', plan: r.payload?.plan ?? '' }) })
      setPasteOpen(false); setCodeText('')
      onChange()
    } catch (e) {
      setNotice({ ok: false, text: errMsg(e, t('lic.activateFail')) })
    } finally { setBusy(false) }
  }

  const handleOnlineActivate = async () => {
    if (!onlineCode.trim()) return
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.onlineActivateLicense(onlineCode)
      if (!r.ok) {
        // 按稳定错误码展示差异化提示（网络/卡密/服务端问题各有自助指引）
        setNotice({ ok: false, text: t(`lic.err.${r.code}`) })
        return
      }
      const { payload } = r.status
      setNotice({ ok: true, text: t('lic.activated', { owner: payload?.owner ?? '', plan: payload?.plan ?? '' }) })
      setOnlineCode('')
      onChange()
    } catch {
      // IPC 本身异常（非业务错误）的兜底
      setNotice({ ok: false, text: t('lic.activateFail') })
    } finally { setBusy(false) }
  }

  const handleCopyFingerprint = () => {
    if (fingerprint) void copyFingerprint(fingerprint)
  }

  const payload = lic.payload

  return (
    <div className="space-y-2 text-xs">
      {lic.valid && payload ? (
        <>
          <StatusRow label={t('lic.status')} value={t('lic.validValue', { plan: payload.plan.toUpperCase() })} ok />
          <StatusRow label={t('lic.holder')} value={payload.owner} ok />
          <StatusRow label={t('lic.expires')} value={new Date(payload.expires_at).toLocaleDateString(locale)} ok />
          {payload.features.length > 0 && (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {t('lic.features')}{payload.features.map((f) => `✅${f}`).join(' ')}
            </div>
          )}
        </>
      ) : lic.expired && payload ? (
        <>
          <StatusRow label={t('lic.status')} value={t('lic.expired', { date: new Date(payload.expires_at).toLocaleDateString(locale) })} ok={false} />
          <StatusRow label={t('lic.holder')} value={payload.owner} ok={false} />
        </>
      ) : (
        <StatusRow label={t('lic.status')} value={t('lic.free')} ok={false} />
      )}

      {!lic.valid && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
          {t('lic.liteLimits', { assistants: 3, kbs: 1 })}
        </p>
      )}

      {lic.valid && (
        <div className="flex gap-2 pt-1">
          <button className="btn-ghost text-[var(--color-danger)]" onClick={handleClear}>{t('lic.clear')}</button>
        </div>
      )}

      {!lic.valid && (
        <>
          {/* 卡密在线激活（主入口） */}
          <div className="space-y-1.5 pt-1">
            <div className="text-[11px] font-medium">{t('lic.onlineTitle')}</div>
            <div className="flex gap-2">
              <input
                className="input font-mono flex-1"
                value={onlineCode}
                onChange={(e) => setOnlineCode(e.target.value)}
                placeholder={t('lic.codePlaceholder')}
                disabled={busy}
              />
              <button className="btn-primary shrink-0" disabled={busy || !onlineCode.trim()} onClick={handleOnlineActivate}>
                {busy ? t('common.processing') : t('lic.onlineActivate')}
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('lic.onlineHint')}</p>
          </div>

          {/* 本机硬盘指纹：离线激活时发给卖家 */}
          <div className="space-y-1.5">
            <StatusRow
              label={t('lic.fpLabel')}
              value={fingerprint ?? t('lic.fpUnavailable')}
              ok={!!fingerprint}
            />
            {fingerprint && (
              <button className="btn-ghost" onClick={handleCopyFingerprint}>
                {fpCopied ? t('lic.copied') : t('lic.copyFingerprint')}
              </button>
            )}
          </div>

          {/* 离线激活（折叠） */}
          <div className="space-y-1.5">
            <button className="btn-ghost" onClick={() => setOfflineOpen((v) => !v)}>
              {offlineOpen ? '▾' : '▸'} {t('lic.offlineTitle')}
            </button>
            {offlineOpen && (
              <div className="space-y-2">
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">{t('lic.offlineHint')}</p>
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={busy} onClick={handleActivate}>
                    {busy ? t('common.processing') : t('lic.activate')}
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => setPasteOpen((v) => !v)}>
                    {t('lic.pasteCode')}
                  </button>
                  <input ref={fileRef} type="file" accept=".lic,.json" className="hidden" onChange={handleFile} />
                </div>
                {pasteOpen && (
                  <div className="space-y-2">
                    <textarea
                      rows={5}
                      value={codeText}
                      onChange={(e) => setCodeText(e.target.value)}
                      placeholder={t('lic.pastePlaceholder')}
                      className="input font-mono text-[11px] resize-none"
                    />
                    <button className="btn-primary" disabled={busy || !codeText.trim()} onClick={handlePasteActivate}>
                      {t('lic.pasteActivate')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {notice && <Notice ok={notice.ok} text={notice.text} />}
    </div>
  )
}

// ─── 快捷浮窗面板 ─────────────────────────────────────────────────

// 修饰键集合：按下纯修饰键时不构成快捷键，继续等待组合
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift'])

// KeyboardEvent → Electron accelerator
// 返回：null=仍是纯修饰键（继续捕获）；''=无效按键；否则为 accelerator 字符串
function eventToAccelerator(e: React.KeyboardEvent): string | null {
  const k = e.key
  if (MODIFIER_KEYS.has(k)) return null
  // 必须包含 Ctrl/⌘ 或 Alt（仅 Shift 的组合全局快捷键在多数平台无法注册）
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return ''

  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  let key = ''
  if (/^[a-zA-Z0-9]$/.test(k)) {
    key = k.toUpperCase()
  } else {
    const SPECIAL: Record<string, string> = {
      ' ': 'Space',
      Enter: 'Return',
      Tab: 'Tab',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      ',': 'Comma',
      '.': 'Period',
      '/': 'Slash',
      '\\': 'Backslash',
      '-': 'Minus',
      '=': 'Equal',
      ';': 'Semicolon',
      "'": 'Quote',
      '`': 'Backquote',
      '[': 'BracketLeft',
      ']': 'BracketRight'
    }
    key = SPECIAL[k] ?? (/^F([1-9]|1[0-9]|2[0-4])$/.test(k) ? k : '')
  }
  return key ? [...mods, key].join('+') : ''
}

const PopupPanel: React.FC = () => {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<PopupConfig | null>(null)
  // 正在捕获哪一个快捷键；candidate 为已捕获到的组合
  const [capturing, setCapturing] = useState<'quick' | 'selection' | null>(null)
  const [candidate, setCandidate] = useState('')
  const [captureErr, setCaptureErr] = useState('')
  const [saveErr, setSaveErr] = useState('')

  useEffect(() => {
    // 失败时降级为「全关 + 空快捷键」，避免 cfg 永远 null 导致面板卡 loading
    window.pocketai.getPopupConfig().then(setCfg).catch((e) => {
      logIpcError('settings.getPopupConfig', e)
      setCfg({ quickEnabled: false, selectionEnabled: false, quickAccelerator: '', selectionAccelerator: '' })
    })
  }, [])

  if (!cfg) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const fmtAccel = (a: string) =>
    a.replace('CommandOrControl', /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl').replace(/\+/g, ' + ')

  // 主进程返回的错误码映射为本地化文案
  const mapResultError = (r: { error?: string; accel?: string }): string => {
    if (r.error === 'same') return t('popup.accelSame')
    if (r.error === 'occupied') {
      const display = r.accel ? fmtAccel(r.accel) : ''
      return t('popup.accelOccupied', { accel: display })
    }
    return t('common.unknownError')
  }

  const toggle = async (key: 'quickEnabled' | 'selectionEnabled') => {
    const prev = cfg
    setCfg({ ...cfg, [key]: !cfg[key] }) // 乐观更新
    const r = await window.pocketai.setPopupConfig({ [key]: !cfg[key] })
    if (r.ok && r.config) {
      setCfg(r.config)
    } else {
      setCfg(prev)
      setSaveErr(mapResultError(r))
    }
  }

  const startCapture = (which: 'quick' | 'selection') => {
    setCapturing(which)
    setCandidate('')
    setCaptureErr('')
    setSaveErr('')
  }

  const onCaptureKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setCapturing(null)
      return
    }
    const accel = eventToAccelerator(e)
    if (accel === null) return // 仍只按了修饰键
    if (accel === '') {
      setCaptureErr(t('popup.accelNeedModifier'))
      return
    }
    setCandidate(accel)
    setCaptureErr('')
  }

  const confirmCapture = async () => {
    if (!capturing || !candidate) return
    const patch =
      capturing === 'quick' ? { quickAccelerator: candidate } : { selectionAccelerator: candidate }
    const r = await window.pocketai.setPopupConfig(patch)
    if (r.ok && r.config) {
      setCfg(r.config)
      setCapturing(null)
      setCandidate('')
    } else {
      setSaveErr(mapResultError(r))
    }
  }

  const rows: Array<{
    which: 'quick' | 'selection'
    key: 'quickEnabled' | 'selectionEnabled'
    title: string
    hint: string
    accel: string
  }> = [
    {
      which: 'quick',
      key: 'quickEnabled',
      title: t('popup.quickTitle'),
      hint: t('popup.quickHint'),
      accel: cfg.quickAccelerator
    },
    {
      which: 'selection',
      key: 'selectionEnabled',
      title: t('popup.selectionTitle'),
      hint: t('popup.selectionHint'),
      accel: cfg.selectionAccelerator
    }
  ]

  return (
    <div className="space-y-2 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="py-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[var(--color-text)]">{r.title}</div>
              <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{r.hint}</div>
            </div>
            <button
              role="switch"
              aria-checked={cfg[r.key]}
              onClick={() => toggle(r.key)}
              className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
                cfg[r.key] ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  cfg[r.key] ? 'translate-x-4' : ''
                }`}
              />
            </button>
          </div>

          {/* 快捷键展示 / 捕获 */}
          <div className="flex items-center gap-2 mt-1 ml-0.5">
            {capturing === r.which ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  autoFocus
                  onKeyDown={onCaptureKeyDown}
                  onBlur={() => {
                    /* 不在 blur 取消：允许点击保存按钮 */
                  }}
                  className="px-2 py-0.5 text-[10px] rounded font-mono border border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-sidebar)] outline-none"
                >
                  {candidate ? fmtAccel(candidate) : t('popup.accelCapturing')}
                </button>
                <button
                  onClick={confirmCapture}
                  disabled={!candidate}
                  className="px-2 py-0.5 text-[10px] rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] disabled:opacity-40"
                >
                  {t('ui.save')}
                </button>
                <button
                  onClick={() => setCapturing(null)}
                  className="px-2 py-0.5 text-[10px] rounded border border-[var(--color-border)]"
                >
                  {t('common.cancel')}
                </button>
                {captureErr && (
                  <span className="text-[10px] text-[var(--color-danger)]">{captureErr}</span>
                )}
              </div>
            ) : (
              <>
                <span className="px-1.5 py-0.5 text-[10px] rounded font-mono bg-[var(--color-sidebar)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                  {fmtAccel(r.accel)}
                </span>
                <button
                  onClick={() => startCapture(r.which)}
                  className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline underline-offset-2"
                >
                  {t('popup.editAccel')}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {saveErr && <div className="text-[10px] text-[var(--color-danger)] pt-0.5">{saveErr}</div>}
      <div className="text-[10px] text-[var(--color-text-muted)] pt-1">{t('popup.settingsNote')}</div>
    </div>
  )
}

// ─── 外观面板（窗口透明度 / 自定义 CSS）────────────────────────

const AppearancePanel: React.FC = () => {
  const { t } = useI18n()
  const [opacity, setOpacity] = useState(1)
  const [css, setCss] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    window.pocketai.getUiPrefs().then((r) => {
      if (r.ok && r.data) {
        setOpacity(r.data.opacity)
        setCss(r.data.customCss)
      }
      setLoaded(true)
    }).catch((e) => {
      // 失败也要解除 loading 门，否则面板永远转圈
      logIpcError('settings.getUiPrefs', e)
      setLoaded(true)
    })
  }, [])

  // 滑块拖动结束后提交（拖动中只更新本地，避免频繁 IPC）
  const commitOpacity = async (value: number) => {
    const r = await window.pocketai.setUiPrefs({ opacity: value })
    if (r.ok && r.data) {
      setOpacity(r.data.opacity)
    } else {
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  const saveCss = async () => {
    const r = await window.pocketai.setUiPrefs({ customCss: css })
    if (r.ok && r.data) {
      setCss(r.data.customCss)
      injectCustomCss(r.data.customCss) // 立即在当前窗口生效
      setNotice({ ok: true, text: t('ui.saved') })
    } else {
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  const resetCss = async () => {
    setCss('')
    const r = await window.pocketai.setUiPrefs({ customCss: '' })
    if (r.ok && r.data) {
      injectCustomCss('')
      setNotice({ ok: true, text: t('ui.saved') })
    }
  }

  if (!loaded) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4 text-xs">
      {/* 窗口透明度 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--color-text)]">{t('ui.opacity')}</span>
          <span className="font-mono text-[var(--color-text-muted)]">{Math.round(opacity * 100)}%</span>
        </div>
        <input
          type="range"
          min={0.6}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          onPointerUp={() => commitOpacity(opacity)}
          onKeyUp={() => commitOpacity(opacity)}
          className="w-full"
        />
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.opacityHint')}</p>
      </div>

      {/* 自定义 CSS */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[var(--color-text)]">{t('ui.customCss')}</span>
          <div className="flex gap-2">
            <button
              onClick={resetCss}
              className="px-2 py-1 text-[11px] rounded border border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]"
            >
              {t('ui.clear')}
            </button>
            <button
              onClick={saveCss}
              className="px-2 py-1 text-[11px] rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
            >
              {t('ui.save')}
            </button>
          </div>
        </div>
        <textarea
          value={css}
          onChange={(e) => setCss(e.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={'body { /* ... */ }'}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] p-2 font-mono text-[11px] resize-y outline-none focus:border-[var(--color-accent)]"
        />
        <p className="text-[10px] text-[var(--color-text-muted)] mt-1">{t('ui.cssHint')}</p>
      </div>

      {notice && (
        <div className={`text-[11px] ${notice.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
          {notice.text}
        </div>
      )}
    </div>
  )
}

// ─── 更新面板 ────────────────────────────────────────────────────

const UpdatePanel: React.FC<{ info: UpdateInfo | null; status: UpdateEvent }> = ({ info, status }) => {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [autoUpdate, setAutoUpdate] = useState<boolean>(info?.autoUpdateEnabled ?? false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogLoading, setChangelogLoading] = useState(false)
  const [changelogError, setChangelogError] = useState<string | null>(null)
  const [releases, setReleases] = useState<Array<{ tag: string; name: string; date: string; body: string; url: string; prerelease: boolean }>>([])

  const handleOpenChangelog = async () => {
    setChangelogOpen(true)
    setChangelogLoading(true)
    setChangelogError(null)
    try {
      const r = await window.pocketai.fetchChangelog()
      if (r.ok && r.releases) {
        setReleases(r.releases)
      } else {
        setChangelogError(r.error ?? t('upd.changelogEmpty'))
      }
    } catch (e) {
      setChangelogError(errMsg(e, t('upd.changelogEmpty')))
    } finally {
      setChangelogLoading(false)
    }
  }

  const handleToggleAutoUpdate = async () => {
    const next = !autoUpdate
    setAutoUpdate(next)
    const r = await window.pocketai.setAutoUpdate(next)
    if (!r.ok) {
      setAutoUpdate(!next)
      setNotice({ ok: false, text: r.error ?? t('common.unknownError') })
    }
  }

  if (!info) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const s = status?.status ?? 'idle'
  const isPackaged = info.isPackaged
  const currentVer = info.currentVersion
  const newVer = status?.newVersion
  const progress = status?.progress ?? 0

  const handleCheck = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.checkUpdate()
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.checkFail') })
    } catch (e) {
      setNotice({ ok: false, text: errMsg(e, t('upd.checkFail')) })
    } finally { setBusy(false) }
  }

  const handleDownload = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.downloadUpdate()
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.downloadFail') })
    } catch (e) {
      setNotice({ ok: false, text: errMsg(e, t('upd.downloadFail')) })
    } finally { setBusy(false) }
  }

  const handleRestart = async () => {
    if (!window.confirm(t('upd.restartConfirm'))) return
    try {
      await window.pocketai.quitAndInstall()
    } catch (e) {
      setNotice({ ok: false, text: errMsg(e, t('upd.installFail')) })
    }
  }

  const statusInfoOf = (): { text: string; color: string } => {
    switch (s) {
      case 'checking':
        return { text: t('upd.checking'), color: 'text-[var(--color-info)]' }
      case 'available':
        return { text: t('upd.available', { v: newVer ?? '' }), color: 'text-[var(--color-warning)]' }
      case 'unavailable':
        return { text: t('upd.unavailable'), color: 'text-[var(--color-success)]' }
      case 'downloading':
        return { text: t('upd.downloading', { p: progress }), color: 'text-[var(--color-info)]' }
      case 'downloaded':
        return { text: t('upd.downloaded', { v: newVer ?? '' }), color: 'text-[var(--color-success)]' }
      case 'error':
        return { text: t('upd.error', { e: status?.error ?? '' }), color: 'text-[var(--color-danger)]' }
      default:
        return { text: t('upd.idle'), color: 'text-[var(--color-text-muted)]' }
    }
  }
  const label = statusInfoOf()

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-3">
        <span className="text-[var(--color-text-muted)]">{t('upd.currentVersion')}</span>
        <span className="font-mono text-[var(--color-text)]">{currentVer}</span>
        {info.isPortable && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-info-bg)] text-[var(--color-info)]">Portable</span>
        )}
        {!isPackaged && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-warning-bg)] text-[var(--color-warning)]">Dev</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="text-[var(--color-text)]">{t('upd.autoUpdate')}</div>
          <div className="text-[10px] text-[var(--color-text-muted)] truncate">{t('upd.autoUpdateHint')}</div>
        </div>
        <button
          role="switch"
          aria-checked={autoUpdate}
          onClick={handleToggleAutoUpdate}
          className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${
            autoUpdate ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
              autoUpdate ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </div>

      <div className={label.color}>{label.text}</div>

      {s === 'downloading' && (
        <div className="w-full h-2 bg-[var(--color-border)] rounded overflow-hidden">
          <div
            className="h-full bg-[var(--color-info)] transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="flex gap-2 pt-1 flex-wrap">
        <button className="btn-ghost" disabled={busy || s === 'checking' || s === 'downloading'} onClick={handleCheck}>
          {t('upd.checkBtn')}
        </button>
        {s === 'available' && (
          <button className="btn-primary" disabled={busy} onClick={handleDownload}>
            {t('upd.downloadBtn', { v: newVer ?? '' })}
          </button>
        )}
        {s === 'downloaded' && (
          <button className="btn-primary" onClick={handleRestart}>
            {t('upd.installBtn')}
          </button>
        )}
        <button className="btn-ghost" onClick={handleOpenChangelog}>
          {t('upd.changelogBtn')}
        </button>
      </div>

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      {!isPackaged && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
          {t('upd.devHint')}
        </p>
      )}

      {isPackaged && info.isPortable && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
          {t('upd.portableHint')}
        </p>
      )}

      <Modal open={changelogOpen} title={t('upd.changelogTitle')} onClose={() => setChangelogOpen(false)} width={520}>
        {changelogLoading ? (
          <div className="text-xs text-[var(--color-text-muted)] text-center py-8">{t('upd.changelogLoading')}</div>
        ) : changelogError ? (
          <div className="text-xs text-[var(--color-danger)] text-center py-8">{t('upd.changelogFail', { e: changelogError })}</div>
        ) : releases.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)] text-center py-8">{t('upd.changelogEmpty')}</div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-4">
            {releases.map((r) => {
              const d = r.date ? new Date(r.date) : null
              const dateStr = d && !isNaN(d.getTime())
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
                : ''
              return (
                <div key={r.tag} className="border-b border-[var(--color-border)]/50 pb-3 last:border-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[13px] font-semibold text-[var(--color-text)]">{r.tag}</span>
                    {r.prerelease && (
                      <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-warning-bg)] text-[var(--color-warning)]">{t('upd.changelogPrerelease')}</span>
                    )}
                    {dateStr && <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">{dateStr}</span>}
                  </div>
                  {r.name && r.name !== r.tag && (
                    <div className="text-[12px] text-[var(--color-text)] mb-1">{r.name}</div>
                  )}
                  {r.body ? (
                    <pre className="text-[11px] text-[var(--color-text-muted)] whitespace-pre-wrap leading-relaxed font-sans">{r.body}</pre>
                  ) : null}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-[11px] text-[var(--color-accent)] hover:underline"
                    >
                      {t('upd.changelogViewOnGitHub')} →
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Modal>
    </div>
  )
}
