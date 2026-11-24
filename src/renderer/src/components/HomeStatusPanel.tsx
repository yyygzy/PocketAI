// 首页状态卡：本地备份（最近一次时间/结果 + 备份、恢复入口）与便携版新版本提示
//
// 三条边界（P2-1 第一刀）：
//  ① 只展示与给入口：不自动备份、不自动恢复、便携版绝不自动下载替换；
//  ② 没有本地备份时不摆「从备份恢复」——入口默认就摆着会暗示「有东西可恢复」；
//  ③ 便携版的检查走 update-manager 已有通道，应用内只给下载页链接（链接可选中复制）。
import React, { useCallback, useEffect, useState } from 'react'
import type { BackupRestoreResult, LocalBackupEntry, UpdateEvent, UpdateInfo } from '../../../shared/types'
import { useI18n } from '../i18n'
import { useConfirm } from './ConfirmDialog'
import { hasIpcFailed, ipcFailText, reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'

type Notice = { ok: boolean; text: string }

export const HomeStatusPanel: React.FC = () => {
  const { t } = useI18n()
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm()

  // ── 本地备份 ──
  const [backups, setBackups] = useState<LocalBackupEntry[] | null>(null)
  const [listErr, setListErr] = useState('')
  const [backing, setBacking] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // 加密包恢复：主进程回令牌 + 文件名，密码在本卡内重试（路径不进渲染层）
  const [restoreTarget, setRestoreTarget] = useState<{ name: string; token: string } | null>(null)
  const [restorePwd, setRestorePwd] = useState('')
  const [restorePwdErr, setRestorePwdErr] = useState('')
  const [restoring, setRestoring] = useState(false)

  // ── 便携版更新 ──
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateEvt, setUpdateEvt] = useState<UpdateEvent | null>(null)
  const [checking, setChecking] = useState(false)

  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const r = await window.pocketai.listLocalBackups()
      if (hasIpcFailed(r)) {
        setListErr(ipcFailText(r, t('common.unknownError')))
        return
      }
      setListErr('')
      setBackups(r)
    } catch (e) {
      setListErr(errText(e, t('common.unknownError')))
    }
  }, [t])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      await window.pocketai.checkUpdate()
    } catch (e) {
      setUpdateEvt({ status: 'error', error: errText(e, t('common.unknownError')) })
    } finally {
      setChecking(false)
    }
  }, [t])

  useEffect(() => {
    let alive = true
    let off: (() => void) | null = null
    // 先包一层 Promise：preload 同步抛出（老版本桥/通道缺失）也要落到 catch，别炸整棵起始屏
    void Promise.resolve()
      .then(() => window.pocketai.getUpdateInfo())
      .then((info) => {
        if (!alive) return
        // 非便携版不进这条：自动更新有自己的一套 UI，首页不该重复摆一份
        if (!info.isPackaged || !info.isPortable) return
        setUpdateInfo(info)
        off = window.pocketai.onUpdateEvent((e) => {
          if (alive) setUpdateEvt(e)
        })
        void runCheck()
      })
      .catch(reportIpcError('home.getUpdateInfo'))
    return () => {
      alive = false
      if (off) off()
    }
  }, [runCheck])

  async function doBackup(): Promise<void> {
    setBacking(true)
    setNotice(null)
    try {
      const r = await window.pocketai.createLocalBackup()
      if (hasIpcFailed(r)) {
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
        return
      }
      setNotice({ ok: true, text: t('bk.localDone', { size: (r.size / 1024).toFixed(1) }) })
      // 新包的名字与时间要立刻上屏，不能等下次启动
      await refreshList()
    } catch (e) {
      setNotice({ ok: false, text: errText(e, t('common.unknownError')) })
    } finally {
      setBacking(false)
    }
  }

  /** 收口恢复结果：成功提示；密码三态在本卡内重试；取消静默 */
  function handleRestoreResult(r: BackupRestoreResult, target: { name: string; token: string } | null): void {
    if (r.ok) {
      setRestoreTarget(null)
      setRestorePwd('')
      setNotice({
        ok: true,
        text: r.passwordChanged ? t('bk.restoreOkPasswordChanged') : t('bk.restoreOk')
      })
      return
    }
    if (r.code === 'needBackupPassword' || r.code === 'badPassword' || r.code === 'legacyNoCross') {
      const next =
        target ?? (r.restoreToken ? { name: r.fileName ?? '', token: r.restoreToken } : null)
      if (next) setRestoreTarget(next)
      setRestorePwdErr(
        r.code === 'badPassword'
          ? t('bk.restoreBadPwd')
          : r.code === 'legacyNoCross'
            ? t('bk.restoreLegacy')
            : ''
      )
      return
    }
    setRestoreTarget(null)
    setNotice({ ok: false, text: t('bk.restoreFail', { e: r.error ?? t('common.unknownError') }) })
  }

  async function doRestorePick(): Promise<void> {
    if (!(await askConfirm({ message: t('bk.localRestoreConfirm'), danger: true }))) return
    setNotice(null)
    setRestoring(true)
    try {
      const r = await window.pocketai.restoreLocalBackup()
      if (r.canceled) return
      handleRestoreResult(r, null)
    } catch (e) {
      setNotice({ ok: false, text: t('bk.restoreFail', { e: errText(e, t('common.unknownError')) }) })
    } finally {
      setRestoring(false)
    }
  }

  async function doRestoreWithPassword(): Promise<void> {
    if (!restoreTarget) return
    const pwd = restorePwd.trim()
    if (!pwd) {
      setRestorePwdErr(t('bk.restoreBadPwd'))
      return
    }
    setRestoring(true)
    try {
      const r = await window.pocketai.restoreLocalBackup({
        restoreToken: restoreTarget.token,
        backupPassword: pwd
      })
      handleRestoreResult(r, restoreTarget)
    } catch (e) {
      setNotice({ ok: false, text: t('bk.restoreFail', { e: errText(e, t('common.unknownError')) }) })
    } finally {
      setRestoring(false)
    }
  }

  const latest = backups && backups.length > 0 ? backups[0]! : null
  const downloadUrl = updateEvt?.downloadUrl

  return (
    <div className="w-full max-w-md mt-4 space-y-2 text-left">
      <div
        className="rounded-lg border border-[var(--color-border)] p-3 space-y-2"
        data-testid="home-backup"
      >
        <div className="text-xs font-medium">{t('home.backupTitle')}</div>
        {listErr ? (
          <div className="text-[11px] text-[var(--color-danger)]">
            {t('home.backupListFail', { e: listErr })}
          </div>
        ) : backups === null ? (
          <div className="text-[11px] text-[var(--color-text-muted)]">{t('home.backupLoading')}</div>
        ) : latest === null ? (
          <div className="text-[11px] text-[var(--color-text-muted)]" data-testid="home-backup-none">
            {t('home.backupNone')}
          </div>
        ) : (
          <>
            <div className="text-[11px]" data-testid="home-backup-last">
              {t('home.backupLast', { time: new Date(latest.mtime).toLocaleString() })}
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {t('home.backupCount', { n: backups.length })}
            </div>
            {/* 首启/换机场景：只说明「这里能恢复」，不做任何自动覆盖 */}
            <div className="text-[11px] text-[var(--color-text-muted)]" data-testid="home-restore-hint">
              {t('home.restoreDetected')}
            </div>
          </>
        )}
        <div className="flex gap-2 flex-wrap">
          <button className="btn-ghost" onClick={() => void doBackup()} disabled={backing}>
            {backing ? t('home.backupBusy') : t('bk.localBtn')}
          </button>
          {latest !== null && (
            <button
              className="btn-ghost"
              data-testid="home-restore"
              onClick={() => void doRestorePick()}
              disabled={restoring}
            >
              {t('bk.localRestoreBtn')}
            </button>
          )}
        </div>
        {restoreTarget && (
          <div className="space-y-1" data-testid="home-restore-pwd">
            <div className="text-[11px] text-[var(--color-text-muted)]">{t('bk.restorePwdTitle')}</div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {t('bk.restorePwdHint', { name: restoreTarget.name })}
            </div>
            <div className="flex gap-2">
              <input
                type="password"
                className="input text-xs flex-1"
                value={restorePwd}
                onChange={(e) => setRestorePwd(e.target.value)}
                placeholder={t('bk.restorePwdPlaceholder')}
              />
              <button className="btn-primary" onClick={() => void doRestoreWithPassword()} disabled={restoring}>
                {t('bk.restorePwdConfirm')}
              </button>
            </div>
            {restorePwdErr && <div className="text-[11px] text-[var(--color-danger)]">{restorePwdErr}</div>}
          </div>
        )}
        {notice && (
          <div
            className={`text-[11px] ${notice.ok ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}
            data-testid="home-backup-notice"
          >
            {notice.text}
          </div>
        )}
      </div>

      {updateInfo && (
        <div
          className="rounded-lg border border-[var(--color-border)] p-3 space-y-2"
          data-testid="home-portable-update"
        >
          <div className="text-xs font-medium">{t('home.portableTitle')}</div>
          {checking ? (
            <div className="text-[11px] text-[var(--color-text-muted)]">{t('home.portableChecking')}</div>
          ) : updateEvt?.status === 'available' && updateEvt.newVersion ? (
            <>
              <div className="text-[11px] text-[var(--color-success)]" data-testid="home-update-available">
                {t('upd.available', { v: updateEvt.newVersion })}
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)]">{t('home.portableHint')}</div>
              {downloadUrl && (
                <>
                  {/* 下载页保留为直通入口；应用内下载安装在「设置 → 通用」里完成 */}
                  <input
                    readOnly
                    className="input font-mono text-[10px] w-full"
                    data-testid="home-update-url"
                    value={downloadUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <a
                    className="text-[11px] text-[var(--color-accent)] underline break-all"
                    href={downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('home.downloadPage')}
                  </a>
                </>
              )}
            </>
          ) : updateEvt?.status === 'error' ? (
            <div className="text-[11px] text-[var(--color-danger)]">
              {t('home.portableCheckFail', { e: updateEvt.error ?? t('common.unknownError') })}
            </div>
          ) : updateEvt?.status === 'unavailable' ? (
            <div className="text-[11px] text-[var(--color-text-muted)]" data-testid="home-update-latest">
              {t('home.portableLatest', { v: updateInfo.currentVersion })}
            </div>
          ) : null}
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
