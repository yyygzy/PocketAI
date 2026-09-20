// FirstRunWizard：首次启动向导 / 换电脑重检向导
//
// 两种变体：
// - full：首次启动（未完成过向导）。欢迎+体检 → 模型推荐 → 安全引导 → 完成
// - recheck：换电脑检测命中（便携盘插到新机器）。硬件可能变化 → 精简重检单页
//
// 触发由 App.tsx 挂载时查询 WIZARD_GET_STATE 决定；关闭时统一调用
// completeWizard() 落盘「已完成」标记和当前机器指纹，下次不再弹出。
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import type {
  HardwareInfo,
  ModelRecommendation,
  EncryptionStatus
} from '../../../../shared/types'

export type WizardVariant = 'full' | 'recheck'

const FULL_STEPS = 4

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export const FirstRunWizard: React.FC<{ variant: WizardVariant; onClose: () => void }> = ({
  variant,
  onClose
}) => {
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [recommendation, setRecommendation] = useState<ModelRecommendation | null>(null)
  const [encStatus, setEncStatus] = useState<EncryptionStatus | null>(null)
  const [hasRecovery, setHasRecovery] = useState<boolean | null>(null)
  const [isPortable, setIsPortable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 加密引导（step 2）输入
  const [pwd, setPwd] = useState('')
  const [pwd2, setPwd2] = useState('')
  const [encDone, setEncDone] = useState(false)
  const [encErr, setEncErr] = useState('')

  useEffect(() => {
    // 硬件画像 boot 时主进程已采集并缓存，这里只读快照（force=false，秒回）
    window.pocketai
      .getHardwareInfo(false)
      .then((hw) => {
        setHardware(hw)
        setIsPortable(hw.disk.removable)
      })
      .catch(() => {})
    window.pocketai.getEncryptionStatus().then(setEncStatus).catch(() => {})
    // 模型推荐含一次 Ollama 端口探测，较轻，后台加载
    window.pocketai
      .recommendModels()
      .then((r) => {
        if (r.ok && r.data) setRecommendation(r.data)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (step === 2 && encStatus?.mode === 'db') {
      window.pocketai.hasRecoveryKey().then(setHasRecovery).catch(() => {})
    }
  }, [step, encStatus])

  async function finish() {
    setBusy(true)
    try {
      await window.pocketai.completeWizard()
    } catch { /* 标记失败不阻塞关闭，下次最多再弹一次 */ }
    onClose()
  }

  async function enableEncryption() {
    setEncErr('')
    if (pwd.length < 6) return setEncErr(t('unlock.pwdTooShort'))
    if (pwd !== pwd2) return setEncErr(t('unlock.pwdMismatch'))
    setBusy(true)
    try {
      const r = await window.pocketai.enableEncryption(pwd)
      if (!r.ok) {
        setEncErr(r.error ?? t('enc.fail'))
        return
      }
      setEncDone(true)
      setPwd(''); setPwd2('')
    } catch (e: any) {
      setEncErr(e?.message ?? t('enc.fail'))
    } finally {
      setBusy(false)
    }
  }

  function gotoSettings() {
    window.dispatchEvent(
      new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'settings' } })
    )
    void finish()
  }

  // ─── 硬件摘要（step0 / recheck 共用） ───
  const hardwareSummary = hardware ? (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
      <Summary label={t('wizard.cpu')} value={`${hardware.cpu.model} × ${hardware.cpu.cores}`} />
      <Summary
        label={t('wizard.memory')}
        value={`${formatBytes(hardware.memory.free)} / ${formatBytes(hardware.memory.total)}`}
      />
      <Summary
        label={t('wizard.gpu')}
        value={
          hardware.gpus.length === 0
            ? t('wizard.noGpu')
            : hardware.gpus
                .map((g) => `${g.name}${g.memory ? ` · ${formatBytes(g.memory)}` : ''}`)
                .join('；')
        }
      />
      <Summary
        label={t('wizard.disk')}
        value={[
          hardware.disk.type,
          hardware.disk.freeSpace != null ? `${t('wizard.free')} ${formatBytes(hardware.disk.freeSpace)}` : '',
          hardware.disk.removable ? t('wizard.removable') : ''
        ]
          .filter(Boolean)
          .join(' · ')}
      />
    </div>
  ) : (
    <div className="text-[12px] text-[var(--color-text-muted)] py-4 text-center">
      {t('common.loading')}
    </div>
  )

  // ─── 换电脑重检：单页 ───
  if (variant === 'recheck') {
    return (
      <Overlay>
        <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
          {t('wizard.recheckTitle')}
        </h1>
        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
          {t('wizard.recheckSubtitle')}
        </p>
        {hardwareSummary}
        {recommendation && (
          <div className="mt-3 rounded-lg border border-[var(--color-border)] p-3 text-[12px]">
            <span className="text-[var(--color-accent)] font-medium">{recommendation.tier}</span>
            <span className="text-[var(--color-text-muted)]"> — {recommendation.summary}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn-primary" disabled={busy} onClick={finish}>
            {t('wizard.recheckDone')}
          </button>
        </div>
      </Overlay>
    )
  }

  // ─── 完整向导 ───
  return (
    <Overlay>
      {/* 步骤指示 */}
      <div className="flex items-center justify-center gap-1.5 mb-4">
        {Array.from({ length: FULL_STEPS }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${
              i === step
                ? 'w-6 bg-[var(--color-accent)]'
                : i < step
                ? 'w-1.5 bg-[var(--color-accent)] opacity-50'
                : 'w-1.5 bg-[var(--color-border)]'
            }`}
          />
        ))}
      </div>

      {step === 0 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.welcomeTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.welcomeSubtitle')}
          </p>
          {hardwareSummary}
          {isPortable && (
            <p className="unlock-recovery-warn mt-3">{t('wizard.portableNote')}</p>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.modelTitle')}
          </h1>
          {!recommendation ? (
            <div className="text-[12px] text-[var(--color-text-muted)] py-4 text-center">
              {t('common.loading')}
            </div>
          ) : (
            <>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-3">
                <span className="text-[var(--color-accent)] font-medium">{recommendation.tier}</span>
                {' — '}
                {recommendation.summary}
              </p>
              {recommendation.localPicks.length > 0 && (
                <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] mb-3">
                  {recommendation.localPicks.map((p) => (
                    <div key={p.id} className="px-3 py-2 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[var(--color-text)]">{p.id}</span>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="px-1.5 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[10px] text-[var(--color-text-muted)]">
                            {p.tag}
                          </span>
                          {p.installed && (
                            <span className="text-[var(--color-success)] text-[10px]">
                              {t('wizard.installed')}
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="text-[var(--color-text-muted)] mt-0.5">{p.reason}</div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                {recommendation.onlineHint}
              </p>
              {recommendation.warnings.map((w, i) => (
                <p key={i} className="text-[11px] text-[var(--color-warning)] leading-relaxed mt-1">
                  ⚠️ {w}
                </p>
              ))}
            </>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.securityTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.securitySubtitle')}
          </p>

          {encStatus?.mode === 'none' ? (
            encDone ? (
              <div className="rounded-lg border border-[var(--color-success)] p-3 text-[12px] text-[var(--color-success)] mb-2">
                ✅ {t('wizard.encDone')}
                <div className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">
                  {t('wizard.encDoneHint')}
                </div>
              </div>
            ) : (
              <>
                <div className="mb-2">
                  <label className="text-[12px] text-[var(--color-text)] block mb-1">
                    {t('unlock.newPassword')}
                  </label>
                  <input
                    type="password"
                    className="input w-full"
                    value={pwd}
                    onChange={(e) => setPwd(e.target.value)}
                    placeholder={t('unlock.phNewPwd')}
                    disabled={busy}
                  />
                </div>
                <div className="mb-2">
                  <label className="text-[12px] text-[var(--color-text)] block mb-1">
                    {t('unlock.confirm')}
                  </label>
                  <input
                    type="password"
                    className="input w-full"
                    value={pwd2}
                    onChange={(e) => setPwd2(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void enableEncryption()}
                    placeholder={t('unlock.phConfirm')}
                    disabled={busy}
                  />
                </div>
                {encErr && <div className="text-[11px] text-[var(--color-danger)] mb-2">{encErr}</div>}
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  {t('wizard.encHint')}
                </p>
              </>
            )
          ) : encStatus?.mode === 'db' ? (
            <div className="rounded-lg border border-[var(--color-border)] p-3 text-[12px] leading-relaxed">
              ✅ {t('wizard.encAlready')}
              {hasRecovery === false && (
                <div className="text-[var(--color-warning)] mt-2 text-[11px]">
                  ⚠️ {t('wizard.noRecoveryHint')}
                </div>
              )}
            </div>
          ) : (
            <div className="text-[12px] text-[var(--color-text-muted)] py-4 text-center">
              {t('common.loading')}
            </div>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.doneTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.doneSubtitle')}
          </p>
          <div className="rounded-lg bg-[var(--color-hover-overlay)] p-3 text-[12px] text-[var(--color-text-muted)] leading-relaxed">
            {t('wizard.doneTips')}
          </div>
        </>
      )}

      {error && <div className="text-[11px] text-[var(--color-danger)] mt-3">{error}</div>}

      {/* 底部操作 */}
      <div className="flex items-center justify-between mt-6">
        <button className="btn-ghost text-[12px]" disabled={busy} onClick={finish}>
          {t('wizard.skip')}
        </button>
        <div className="flex gap-2">
          {step === 1 && (
            <button className="btn-ghost" disabled={busy} onClick={gotoSettings}>
              {t('wizard.gotoSettings')}
            </button>
          )}
          {step === 2 && encStatus?.mode === 'none' && !encDone && (
            <button className="btn-primary" disabled={busy} onClick={enableEncryption}>
              {busy ? t('common.processing') : t('wizard.encBtn')}
            </button>
          )}
          {step < FULL_STEPS - 1 ? (
            <button
              className="btn-primary"
              disabled={busy || (step === 2 && encStatus?.mode === 'none' && !encDone && pwd.length > 0)}
              onClick={() => setStep((s) => s + 1)}
            >
              {t('wizard.next')}
            </button>
          ) : (
            <button className="btn-primary" disabled={busy} onClick={finish}>
              {busy ? t('common.processing') : t('wizard.finish')}
            </button>
          )}
        </div>
      </div>
    </Overlay>
  )
}

const Overlay: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm">
    <div className="w-[580px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] p-6 shadow-2xl">
      {children}
    </div>
  </div>
)

const Summary: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-[var(--color-text)] mt-0.5 break-all" title={value}>
      {value}
    </div>
  </div>
)
