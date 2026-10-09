// 锁屏遮罩：主窗口与浮窗共用一份
//
// 抽出来的原因不是"少几行"：SEC-31 的诚实化文案（none 模式只遮界面、不保护数据）
// 当时要在 App.tsx 与 DetachedApp.tsx 各改一遍，两处一旦漂移就会出现
// 「主窗口说实话、浮窗仍在暗示已受保护」。现在两窗口渲染同一组件，
// 用例（tests/renderer-lock-overlay.test.tsx）也只测这一份。
import React from 'react'
import { useI18n } from '../i18n'

export const LockOverlay: React.FC<{
  dbEncrypted: boolean
  pwd: string
  onPwdChange: (v: string) => void
  error?: string
  onUnlock: () => void
}> = ({ dbEncrypted, pwd, onPwdChange, error, onUnlock }) => {
  const { t } = useI18n()
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm">
      <div className="w-80 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-8 text-center shadow-2xl">
        <div className="mb-4 text-4xl">🔒</div>
        <h2 className="mb-2 text-xl font-semibold text-[var(--color-text)]">{t('lock.locked')}</h2>
        <p className="mb-6 text-sm text-[var(--color-text-muted)]">{dbEncrypted ? t('lock.protected') : t('lock.plainModeNote')}</p>
        {dbEncrypted && (
          <input
            type="password"
            autoFocus
            value={pwd}
            onChange={(e) => onPwdChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onUnlock()}
            placeholder={t('lock.pwdPlaceholder')}
            className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-4 py-2 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        )}
        {error && <div className="mb-3 text-sm text-[var(--color-danger)]">{error}</div>}
        <button
          onClick={onUnlock}
          className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-on-accent)] hover:opacity-90"
        >
          {/* none 模式没有凭据可校验，按钮文案不许暗示「解锁=受保护」 */}
          {dbEncrypted ? t('lock.unlock') : t('lock.unlockNow')}
        </button>
      </div>
    </div>
  )
}
