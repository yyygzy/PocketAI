// UnlockPage：解锁窗口渲染组件
// 两种模式：
// - unlock：DB 已加密，用户输入密码解锁
// - setPassword：首次加密明文 DB，用户设置新密码
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'

type UnlockMode = 'unlock' | 'setPassword'

export function UnlockPage() {
  const { t } = useI18n()
  const [mode, setMode] = useState<UnlockMode>('unlock')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // 从 URL 参数读取模式：unlock.html?mode=setPassword
    const params = new URLSearchParams(window.location.search)
    if (params.get('mode') === 'setPassword') {
      setMode('setPassword')
    }
  }, [])

  async function handleSubmit() {
    setError('')
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

  return (
    <div className="unlock-page">
      <div className="unlock-card">
        <h1 className="unlock-title">
          {mode === 'unlock' ? t('unlock.title') : t('unlock.setTitle')}
        </h1>
        <p className="unlock-subtitle">
          {mode === 'unlock' ? t('unlock.subtitle') : t('unlock.setSubtitle')}
        </p>

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

        {mode === 'setPassword' && (
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
        )}

        {error && <div className="unlock-error">{error}</div>}

        <button
          className="unlock-btn"
          onClick={handleSubmit}
          disabled={busy}
        >
          {busy
            ? t('common.processing')
            : mode === 'unlock'
            ? t('unlock.btn')
            : t('unlock.setBtn')}
        </button>

        <div className="unlock-hint">
          <p>
            {t('unlock.kdf')}<code>Argon2id</code>
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
