import React, { useEffect, useRef, useState } from 'react'
import type { AppPaths, EncryptionStatus } from '../../../../shared/types'
import { ProviderSettings, Notice } from './ProviderSettings'
import { useI18n } from '../../i18n'

export const SettingsModule: React.FC = () => {
  const { t } = useI18n()
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [enc, setEnc] = useState<EncryptionStatus | null>(null)
  const [lic, setLic] = useState<any>(null)
  const [updateInfo, setUpdateInfo] = useState<any>(null)
  const [updateStatus, setUpdateStatus] = useState<any>({ status: 'idle' })

  useEffect(() => {
    window.pocketai.getPaths().then(setPaths)
    window.pocketai.getEncryptionStatus().then(setEnc)
    window.pocketai.getLicenseStatus().then(setLic)
    window.pocketai.getUpdateInfo().then(setUpdateInfo)
    // 监听主进程推送的更新状态事件
    const unsub = window.pocketai.onUpdateEvent((data: any) => {
      setUpdateStatus(data)
    })
    return unsub
  }, [])

  const refreshEnc = () => window.pocketai.getEncryptionStatus().then(setEnc)

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        <ProviderSettings />

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.encryption')}</h3>
          <EncryptionPanel enc={enc} onChange={refreshEnc} />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] pt-4">
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.backup')}</h3>
          <BackupPanel />
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
          <h3 className="text-sm font-semibold text-[var(--color-text)] mb-3">{t('set.license')}</h3>
          <LicensePanel lic={lic} onChange={() => window.pocketai.getLicenseStatus().then(setLic)} />
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

      <div className="flex flex-wrap gap-2 pt-1">
        {!encrypted && <EnableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <ChangePasswordBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && unlocked && <DisableEncryptionBtn onDone={onChange} setNotice={setNotice} />}
        {encrypted && !unlocked && <LockBtn onDone={onChange} />}
      </div>

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
    } catch (e: any) {
      setLocalErr(e?.message ?? t('enc.fail'))
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
    } catch (e: any) {
      setLocalErr(e?.message ?? t('enc.fail'))
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
    } catch (e: any) {
      setLocalErr(e?.message ?? t('enc.fail'))
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

// ─── 备份面板 ────────────────────────────────────────────────────

interface WDConfig {
  url: string
  username: string
  passwordCipher: string
  directory: string
}

const BackupPanel: React.FC = () => {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<WDConfig | null>(null)
  const [webdavList, setWebdavList] = useState<any[]>([])
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
    })
  }, [])

  const showNotice = (ok: boolean, text: string) => setNotice({ ok, text })

  async function saveWD() {
    if (!wdUrl || !wdUser) return showNotice(false, t('bk.urlUserRequired'))
    const c: any = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
    await window.pocketai.saveWebDAVConfig(c)
    setCfg(c); showNotice(true, t('bk.cfgSaved'))
  }

  async function testWD() {
    const c: any = { url: wdUrl, username: wdUser, passwordCipher: wdPwd || cfg?.passwordCipher || '', directory: wdDir }
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
    showNotice(true, t('bk.encDoing'))
    const r = await window.pocketai.createEncryptedLocalBackup()
    showNotice(true, t('bk.encDone', { size: (r.size / 1024).toFixed(1) }))
  }

  async function doUpload() {
    showNotice(true, t('bk.uploading'))
    const r = await window.pocketai.uploadWebDAVBackup()
    if (r.ok === false) { showNotice(false, t('bk.uploadFail', { e: r.error ?? t('common.unknownError') })); return }
    showNotice(true, t('bk.uploaded', { name: r.filename ?? '' }))
    await refreshList()
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

      {/* 本地备份 */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-2">{t('bk.localTitle')}</div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={doLocalBackup}>{t('bk.localBtn')}</button>
          <button className="btn-ghost" onClick={doEncBackup}>{t('bk.encBtn')}</button>
        </div>
      </div>

      {/* WebDAV 操作 */}
      {cfg && (
        <div>
          <div className="flex gap-2 mb-2">
            <button className="btn-primary" onClick={doUpload}>{t('bk.uploadBtn')}</button>
            <button className="btn-ghost" onClick={refreshList} disabled={listLoading}>
              {listLoading ? `⏳ ${t('common.loading')}` : t('bk.refresh')}
            </button>
          </div>

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
                  {webdavList.map((f: any) => (
                    <tr key={f.name} className="border-t border-[var(--color-border)]/40 hover:bg-[var(--color-hover-overlay)]">
                      <td className="px-3 py-1.5 font-mono truncate max-w-[240px]" title={f.name}>
                        {f.encrypted && <span className="text-[var(--color-warning)] mr-1">🔒</span>}
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

const LicensePanel: React.FC<{ lic: any; onChange: () => void }> = ({ lic, onChange }) => {
  const { t, lang } = useI18n()
  const locale = lang === 'en' ? 'en-US' : 'zh-CN'
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
    } catch (e: any) {
      setNotice({ ok: false, text: e?.message ?? t('lic.activateFail') })
    } finally { setBusy(false) }
  }

  const handleClear = async () => {
    if (!window.confirm(t('lic.clearConfirm'))) return
    await window.pocketai.clearLicense()
    setNotice({ ok: true, text: t('lic.cleared') })
    onChange()
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
              {t('lic.features')}{payload.features.map((f: string) => `✅${f}`).join(' ')}
            </div>
          )}
        </>
      ) : lic.expired && payload ? (
        <>
          <StatusRow label={t('lic.status')} value={t('lic.expired', { date: new Date(payload.expires_at).toLocaleDateString(locale) })} ok={false} />
          <StatusRow label={t('lic.holder')} value={payload.owner} ok />
        </>
      ) : (
        <StatusRow label={t('lic.status')} value={t('lic.free')} ok={false} />
      )}

      <div className="flex gap-2 pt-1">
        <button className="btn-primary" disabled={busy} onClick={handleActivate}>
          {busy ? t('common.processing') : t('lic.activate')}
        </button>
        {lic.valid && (
          <button className="btn-ghost text-[var(--color-danger)]" onClick={handleClear}>{t('lic.clear')}</button>
        )}
        <input ref={fileRef} type="file" accept=".lic,.json" className="hidden" onChange={handleFile} />
      </div>

      {notice && <Notice ok={notice.ok} text={notice.text} />}

      {!lic.valid && !lic.expired && (
        <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed pt-1">
          {t('lic.hint')}
        </p>
      )}
    </div>
  )
}

// ─── 快捷浮窗面板 ─────────────────────────────────────────────────

const PopupPanel: React.FC = () => {
  const { t } = useI18n()
  const [cfg, setCfg] = useState<any>(null)

  useEffect(() => {
    window.pocketai.getPopupConfig().then(setCfg)
  }, [])

  if (!cfg) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const fmtAccel = (a: string) =>
    a.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl').replace(/\+/g, ' + ')

  const toggle = async (key: 'quickEnabled' | 'selectionEnabled') => {
    const next = { ...cfg, [key]: !cfg[key] }
    setCfg(next) // 乐观更新
    try {
      const saved = await window.pocketai.setPopupConfig({ [key]: !cfg[key] })
      setCfg(saved)
    } catch {
      setCfg(cfg)
    }
  }

  const rows: Array<{ key: 'quickEnabled' | 'selectionEnabled'; title: string; hint: string; accel: string }> = [
    { key: 'quickEnabled', title: t('popup.quickTitle'), hint: t('popup.quickHint'), accel: cfg.quickAccelerator },
    { key: 'selectionEnabled', title: t('popup.selectionTitle'), hint: t('popup.selectionHint'), accel: cfg.selectionAccelerator }
  ]

  return (
    <div className="space-y-2 text-xs">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-3 py-1">
          <div className="min-w-0">
            <div className="text-[var(--color-text)]">
              {r.title}
              <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded font-mono bg-[var(--color-sidebar)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                {fmtAccel(r.accel)}
              </span>
            </div>
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
      ))}
      <div className="text-[10px] text-[var(--color-text-muted)] pt-1">{t('popup.settingsNote')}</div>
    </div>
  )
}

// ─── 更新面板 ────────────────────────────────────────────────────

const UpdatePanel: React.FC<{ info: any; status: any }> = ({ info, status }) => {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [autoUpdate, setAutoUpdate] = useState<boolean>(info?.autoUpdateEnabled ?? false)

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
    } catch (e: any) {
      setNotice({ ok: false, text: e?.message ?? t('upd.checkFail') })
    } finally { setBusy(false) }
  }

  const handleDownload = async () => {
    setBusy(true); setNotice(null)
    try {
      const r = await window.pocketai.downloadUpdate()
      if (!r.ok) setNotice({ ok: false, text: r.error ?? t('upd.downloadFail') })
    } catch (e: any) {
      setNotice({ ok: false, text: e?.message ?? t('upd.downloadFail') })
    } finally { setBusy(false) }
  }

  const handleRestart = async () => {
    if (!window.confirm(t('upd.restartConfirm'))) return
    try {
      await window.pocketai.quitAndInstall()
    } catch (e: any) {
      setNotice({ ok: false, text: e?.message ?? t('upd.installFail') })
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

      <div className="flex gap-2 pt-1">
        <button className="btn-ghost" disabled={busy || s === 'checking' || s === 'downloading'} onClick={handleCheck}>
          {t('upd.checkBtn')}
        </button>
        {s === 'available' && (
          <button className="btn-primary" disabled={busy} onClick={handleDownload}>
            {t('upd.downloadBtn', { v: newVer })}
          </button>
        )}
        {s === 'downloaded' && (
          <button className="btn-primary" onClick={handleRestart}>
            {t('upd.installBtn')}
          </button>
        )}
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
    </div>
  )
}
