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
  /** 这一发读有没有成功回来（§343）：不知道就不能说"数据仍是明文"，也不能说"已激活" */
  encKnown: boolean
  /** 读还在飞（§343）：此刻连"要不要口令"都还没定，按钮不许点 */
  encPending: boolean
  /** 读失败的原因（§343）：中性那句要把原因带上，否则用户只看到"正在确认"却永远不结束 */
  encErr?: string | null
  pwd: string
  onPwdChange: (v: string) => void
  error?: string
  onUnlock: () => void
}> = ({ dbEncrypted, encKnown, encPending, encErr, pwd, onPwdChange, error, onUnlock }) => {
  const { t } = useI18n()
  // 要口令的三种脸：确认已加密⇒要；确认没加密⇒不要；读不到⇒按"可能设过主密码"处理（宁可多问一句，
  // 也不空发一发 undefined 去白吃一次限流失败计数）；还在飞⇒什么都不给
  const askPwd = !encPending && (dbEncrypted || !encKnown)
  const subtitle = encKnown
    ? (dbEncrypted ? t('lock.protected') : t('lock.plainModeNote'))
    : encPending
      ? t('lock.checkingEnc')
      : t('lock.encUnread', { msg: encErr ?? '' })
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm">
      <div className="w-80 rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-8 text-center shadow-2xl">
        <div className="mb-4 text-4xl">🔒</div>
        <h2 className="mb-2 text-xl font-semibold text-[var(--color-text)]">{t('lock.locked')}</h2>
        <p className="mb-6 text-sm text-[var(--color-text-muted)]">{subtitle}</p>
        {askPwd && (
          <input
            type="password"
            autoFocus
            value={pwd}
            onChange={(e) => onPwdChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && onUnlock()}
            placeholder={t('lock.pwdPlaceholder')}
            className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-input-bg)] px-4 py-2 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        )}
        {/* §372：恢复码那一格只长在启动解锁窗（ENCRYPTION_RECOVER 不在锁屏白名单），
            这句只给"确认已加密"时——none／确认中／读不到都不许暗示有恢复途径（文案只承诺已证实之事）。 */}
        {encKnown && dbEncrypted && (
          <p className="mb-4 text-xs text-[var(--color-text-muted)]">{t('lock.recoveryHint')}</p>
        )}
        {error && <div className="mb-3 text-sm text-[var(--color-danger)]">{error}</div>}
        <button
          onClick={onUnlock}
          disabled={encPending}
          className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 font-medium text-[var(--color-on-accent)] hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-100"
        >
          {/* none 模式没有凭据可校验，按钮文案不许暗示「解锁=受保护」；确认中则根本不给出可点的按钮 */}
          {encPending
            ? t('common.processing')
            : encKnown && !dbEncrypted
              ? t('lock.unlockNow')
              : t('lock.unlock')}
        </button>
      </div>
    </div>
  )
}
