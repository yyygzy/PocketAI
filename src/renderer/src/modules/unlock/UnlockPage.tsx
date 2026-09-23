// UnlockPage：解锁窗口渲染组件
// 三种模式：
// - unlock：DB 已加密，输入密码解锁
// - setPassword：首次加密明文 DB，设置新密码
// - recovery：忘记密码，用恢复码 + 新密码重置
import { useEffect, useRef, useState } from 'react'
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

  // ── B5：渲染层防暴力（前端只做禁用+倒计时；主进程侧防暴力为后续加固 TODO）──
  const [showPwd, setShowPwd] = useState(false)
  const failCountRef = useRef(0) // 连续失败计数（仅用于退避判断，不参与渲染）
  const [lockedUntil, setLockedUntil] = useState(0) // 0 = 未锁定；否则退避结束时间戳
  const [remainingMs, setRemainingMs] = useState(0)

  useEffect(() => {
    if (!lockedUntil) return
    const tick = () => {
      const left = lockedUntil - Date.now()
      if (left <= 0) {
        setRemainingMs(0)
        setLockedUntil(0)
      } else {
        setRemainingMs(left)
      }
    }
    tick()
    const id = window.setInterval(tick, 200)
    return () => window.clearInterval(id)
  }, [lockedUntil])

  // 连续错误 ≥5 次起锁；每次失败延时翻倍，上限 30s
  function noteAuthFailure() {
    const next = failCountRef.current + 1
    failCountRef.current = next
    if (next >= 5) {
      const backoff = Math.min(1000 * 2 ** (next - 5), 30000)
      setLockedUntil(Date.now() + backoff)
    }
  }

  function resetFail() {
    failCountRef.current = 0
    setLockedUntil(0)
    setRemainingMs(0)
  }

  // 密码输入框 + 显隐按钮（unlock/setPassword/recovery 三处复用）
  const renderPwd = (opts: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    autoFocus?: boolean
    disabled?: boolean
  }) => (
    <div style={{ position: 'relative' }}>
      <input
        type={showPwd ? 'text' : 'password'}
        value={opts.value}
        onChange={(e) => opts.onChange(e.target.value)}
        placeholder={opts.placeholder}
        autoFocus={opts.autoFocus}
        disabled={opts.disabled}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
        style={{ paddingRight: 32 }}
      />
      <button
        type="button"
        onClick={() => setShowPwd((v) => !v)}
        aria-label={showPwd ? t('unlock.hidePwd') : t('unlock.showPwd')}
        title={showPwd ? t('unlock.hidePwd') : t('unlock.showPwd')}
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 4,
          fontSize: 16,
          color: 'var(--color-text-muted)'
        }}
      >
        {showPwd ? '🙈' : '👁'}
      </button>
    </div>
  )

  // 恢复成功后的「进入应用」：rekey 已完成，用新密码走正常解锁收尾
  // （boot：提交协调器继续启动；运行时：重开 DB 探针 + 关闭解锁窗 + 解锁状态机）
  async function finishAfterRecovery() {
    setBusy(true)
    try {
      const res = await window.pocketai.unlockEncryption(password)
      if (!res.ok) {
        setError(t('unlock.recoverFinishFail'))
        noteAuthFailure()
      } else {
        resetFail()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('unlock.submitFailed'))
      noteAuthFailure()
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
          noteAuthFailure()
          return
        }
        // 重置成功，清空失败计数
        resetFail()
        // 停在成功页展示新恢复码，用户确认保存后再进入应用
        setNewCode(r.recoveryCode)
      } catch (e) {
        setError(e instanceof Error ? e.message : t('unlock.recoverFailed'))
        noteAuthFailure()
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
        noteAuthFailure()
        return
      }
      // 成功：重置失败计数（unlock 后窗口由主进程关闭）
      resetFail()
      // 提交后窗口会被主进程关闭
    } catch (e) {
      setError(e instanceof Error ? e.message : t('unlock.submitFailed'))
      noteAuthFailure()
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
                } catch {
                  // 恢复码复制失败必须提示：用户误以为已复制会导致无法找回数据
                  setError(t('common.copyFailed'))
                }
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
          <button className="unlock-btn" onClick={finishAfterRecovery} disabled={busy || remainingMs > 0}>
            {remainingMs > 0
              ? t('unlock.tooManyAttempts', { s: Math.ceil(remainingMs / 1000) })
              : busy
              ? t('common.processing')
              : t('unlock.enterApp')}
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
            {renderPwd({
              value: password,
              onChange: setPassword,
              placeholder: t('unlock.phPwd'),
              autoFocus: true,
              disabled: busy || remainingMs > 0
            })}
          </div>
        )}

        {(mode === 'setPassword' || mode === 'recovery') && (
          <>
            {mode === 'recovery' && (
              <div className="unlock-field">
                <label>{t('unlock.newPassword')}</label>
                {renderPwd({
                  value: password,
                  onChange: setPassword,
                  placeholder: t('unlock.phNewPwd'),
                  disabled: busy || remainingMs > 0
                })}
              </div>
            )}
            <div className="unlock-field">
              <label>{t('unlock.confirm')}</label>
              {renderPwd({
                value: confirm,
                onChange: setConfirm,
                placeholder: t('unlock.phConfirm'),
                disabled: busy || remainingMs > 0
              })}
            </div>
          </>
        )}

        {error && <div className="unlock-error">{error}</div>}

        <button className="unlock-btn" onClick={handleSubmit} disabled={busy || remainingMs > 0}>
          {remainingMs > 0
            ? t('unlock.tooManyAttempts', { s: Math.ceil(remainingMs / 1000) })
            : busy
            ? t('common.processing')
            : btnText}
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
