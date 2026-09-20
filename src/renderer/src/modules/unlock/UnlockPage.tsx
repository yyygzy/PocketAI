// UnlockPage：解锁窗口渲染组件
// 三种模式：
// - unlock：DB 已加密，输入密码解锁
// - setPassword：首次加密明文 DB，设置新密码
// - recovery：忘记密码，用恢复码 + 新密码重置
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'

type UnlockMode = 'unlock' | 'setPassword' | 'recovery'

export function UnlockPage() {
  const { t } = useI18n()
  const [mode, setMode] = useState<UnlockMode>('unlock')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [newCode, setNewCode] = useState('') // 恢复成功后服务端签发的新恢复码
  const [copied, setCopied] = useState(false) // 恢复码已复制到剪贴板（将自动清除）
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 从 URL 参数读取模式：unlock.html?mode=setPassword
    const params = new URLSearchParams(window.location.search)
    if (params.get('mode') === 'setPassword') {
      setMode('setPassword')
    }
  }, [])

  // 恢复成功后的「进入应用」：rekey 已完成，用新密码走正常解锁收尾
  // （boot：提交协调器继续启动；运行时：重开 DB 探针 + 关闭解锁窗 + 解锁状态机）
  async function finishAfterRecovery() {
    setBusy(true)
    try {
      const res = await window.pocketai.unlockEncryption(password)
      if (!res.ok) setError(t('unlock.recoverFinishFail'))
    } catch (e: any) {
      setError(e?.message ?? t('unlock.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function saveCodeFile(code: string) {
    await window.pocketai.saveRecoveryFile(code)
  }

  async function handleSubmit() {
    setError('')

    if (mode === 'recovery') {
      if (!recoveryCode.trim()) {
        setError(t('unlock.enterRecovery'))
        return
      }
      if (password.length < 6) {
        setError(t('unlock.pwdTooShort'))
        return
      }
      if (password !== confirm) {
        setError(t('unlock.pwdMismatch'))
        return
      }
      setBusy(true)
      try {
        const r = await window.pocketai.recoverWithCode(recoveryCode, password)
        if (!r.ok || !r.recoveryCode) {
          setError(r.error ?? t('unlock.recoverFailed'))
          return
        }
        // 停在成功页展示新恢复码，用户确认保存后再进入应用
        setNewCode(r.recoveryCode)
      } catch (e: any) {
        setError(e?.message ?? t('unlock.recoverFailed'))
      } finally {
        setBusy(false)
      }
      return
    }

    if (!password) {
      setError(t('unlock.enterPwd'))
      return
    }

    if (mode === 'setPassword') {
      if (password.length < 6) {
        setError(t('unlock.pwdTooShort'))
        return
      }
      if (password !== confirm) {
        setError(t('unlock.pwdMismatch'))
        return
      }
    }

    setBusy(true)
    try {
      let res: { ok: boolean; error?: string }
      if (mode === 'unlock') {
        res = await window.pocketai.unlockEncryption(password)
      } else {
        res = await window.pocketai.setMasterPassword(password)
      }
      if (!res.ok) {
        setError(res.error ?? t('unlock.submitFailed'))
        return
      }
      // 提交后窗口会被主进程关闭
    } catch (e: any) {
      setError(e?.message ?? t('unlock.submitFailed'))
    } finally {
      setBusy(false)
    }
  }

  // ─── 恢复成功页：强制展示并要求保存新恢复码 ───
  if (newCode) {
    return (
      <div className="unlock-page">
        <div className="unlock-card">
          <h1 className="unlock-title">{t('unlock.recoveredTitle')}</h1>
          <p className="unlock-subtitle">{t('unlock.recoveredSubtitle')}</p>
          <div className="unlock-field">
            <label>{t('unlock.newRecoveryLabel')}</label>
            <textarea
              className="recovery-code-box"
              readOnly
              value={newCode}
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className="flex gap-2 mb-3">
            <button
              className="unlock-btn-secondary"
              onClick={async () => {
                try {
                  await window.pocketai.copySensitiveToClipboard(newCode)
                  setCopied(true)
                } catch { /* 剪贴板不可用时静默 */ }
              }}
            >
              {t('unlock.copyCode')}
            </button>
            <button className="unlock-btn-secondary" onClick={() => saveCodeFile(newCode)}>
              {t('unlock.saveCodeFile')}
            </button>
          </div>
          {copied && <p className="unlock-recovery-warn">{t('enc.clipboardAutoClear', { s: 30 })}</p>}
          <p className="unlock-recovery-warn">{t('unlock.recoveryWarn')}</p>
          {error && <div className="unlock-error">{error}</div>}
          <button className="unlock-btn" onClick={finishAfterRecovery} disabled={busy}>
            {busy ? t('common.processing') : t('unlock.enterApp')}
          </button>
        </div>
      </div>
    )
  }

  const btnText =
    mode === 'recovery'
      ? t('unlock.recoverBtn')
      : mode === 'unlock'
      ? t('unlock.btn')
      : t('unlock.setBtn')

  return (
    <div className="unlock-page">
      <div className="unlock-card">
        <h1 className="unlock-title">
          {mode === 'unlock'
            ? t('unlock.title')
            : mode === 'setPassword'
            ? t('unlock.setTitle')
            : t('unlock.recoveryTitle')}
        </h1>
        <p className="unlock-subtitle">
          {mode === 'unlock'
            ? t('unlock.subtitle')
            : mode === 'setPassword'
            ? t('unlock.setSubtitle')
            : t('unlock.recoverySubtitle')}
        </p>

        {mode === 'recovery' && (
          <div className="unlock-field">
            <label>{t('unlock.recoveryCode')}</label>
            <input
              type="text"
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="recovery-code-input"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              placeholder={t('unlock.phRecovery')}
              disabled={busy}
            />
          </div>
        )}

        {mode !== 'recovery' && (
          <div className="unlock-field">
            <label>{t('unlock.password')}</label>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              placeholder={t('unlock.phPwd')}
              disabled={busy}
            />
          </div>
        )}

        {(mode === 'setPassword' || mode === 'recovery') && (
          <>
            {mode === 'recovery' && (
              <div className="unlock-field">
                <label>{t('unlock.newPassword')}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('unlock.phNewPwd')}
                  disabled={busy}
                />
              </div>
            )}
            <div className="unlock-field">
              <label>{t('unlock.confirm')}</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder={t('unlock.phConfirm')}
                disabled={busy}
              />
            </div>
          </>
        )}

        {error && <div className="unlock-error">{error}</div>}

        <button className="unlock-btn" onClick={handleSubmit} disabled={busy}>
          {busy ? t('common.processing') : btnText}
        </button>

        <div className="unlock-switch">
          {mode === 'unlock' && (
            <button type="button" onClick={() => { setMode('recovery'); setError('') }} disabled={busy}>
              {t('unlock.useRecovery')}
            </button>
          )}
          {mode === 'recovery' && (
            <button type="button" onClick={() => { setMode('unlock'); setError('') }} disabled={busy}>
              {t('unlock.backToPwd')}
            </button>
          )}
        </div>

        <div className="unlock-hint">
          <p>
            {t('unlock.kdf')}<code>scrypt</code>
          </p>
          <p>
            {t('unlock.enc')}<code>AES-256-GCM</code>
          </p>
          <p>
            {t('unlock.warn')}
          </p>
        </div>
      </div>
    </div>
  )
}
