// FirstRunWizard：首次启动向导 / 换电脑重检向导
//
// 两种变体：
// - full：首次启动（未完成过向导）。欢迎 → 快速配置 → 完成
// - recheck：换电脑检测命中（便携盘插到新机器）。硬件可能变化 → 精简重检单页
//
// 重构说明：原 4 步（欢迎→模型→加密→完成）合并为 3 步，把 provider + API key + assistant
// 聚合到单页「快速配置」，加密降级为完成页的可选卡片，目标新用户 3 分钟内跑通。
import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { OllamaPanel } from '../../components/OllamaPanel'
import { PROVIDER_PRESETS } from '../settings/ProviderSettings'
import type {
  HardwareInfo,
  ModelRecommendation,
  EncryptionStatus,
  ProviderRecord,
  AssistantRecord,
  ProviderType,
} from '../../../../shared/types'

export type WizardVariant = 'full' | 'recheck'

const FULL_STEPS = 3

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

// 向导里优先展示的预设（按中文用户常用度排序）
const WIZARD_PRESET_LABELS = ['DeepSeek', 'OpenAI', 'Anthropic Claude', 'Moonshot 月之暗面', 'Ollama', 'LM Studio']

export const FirstRunWizard: React.FC<{ variant: WizardVariant; onClose: () => void }> = ({
  variant,
  onClose,
}) => {
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [hardware, setHardware] = useState<HardwareInfo | null>(null)
  const [recommendation, setRecommendation] = useState<ModelRecommendation | null>(null)
  const [encStatus, setEncStatus] = useState<EncryptionStatus | null>(null)
  const [isPortable, setIsPortable] = useState(false)
  const [busy, setBusy] = useState(false)

  // Step 1: Quick Setup state
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [selectedPreset, setSelectedPreset] = useState<{ type: ProviderType; baseUrl: string; label: string; needKey: boolean } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [selectedAssistantId, setSelectedAssistantId] = useState<string | null>(null)
  const [setupErr, setSetupErr] = useState('')
  const [savedProviderId, setSavedProviderId] = useState<string | null>(null)

  // Step 2: Encryption state
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

    // 加载已有 provider + assistant（向导 Step 1 用）
    window.pocketai.listProviders().then(setProviders).catch(() => {})
    window.pocketai.listAssistants().then((list) => {
      setAssistants(list)
      // 默认选中第一个内置助手
      const firstBuiltin = list.find((a) => a.isBuiltin)
      if (firstBuiltin) setSelectedAssistantId(firstBuiltin.id)
    }).catch(() => {})
  }, [])

  async function finish() {
    setBusy(true)
    try {
      await window.pocketai.completeWizard()
    } catch { /* 标记失败不阻塞关闭 */ }
    onClose()
  }

  async function saveProviderAndAssistant() {
    setSetupErr('')
    if (!selectedPreset) {
      setSetupErr(t('wizard.pickProvider'))
      return
    }
    if (!selectedAssistantId) {
      setSetupErr(t('wizard.pickAssistant'))
      return
    }
    if (selectedPreset.needKey && !apiKey.trim()) {
      setSetupErr(t('wizard.apiKeyRequired'))
      return
    }

    setBusy(true)
    try {
      // 1. 保存 provider
      let providerId: string
      if (selectedPreset.needKey) {
        const existing = providers.find((p) => p.baseUrl === selectedPreset.baseUrl)
        if (existing) {
          // 已有同 baseUrl 的 provider，追加新 key
          const updated = await window.pocketai.saveProvider({
            ...existing,
            apiKeys: [...existing.apiKeys, apiKey.trim()],
          })
          providerId = updated.id
        } else {
          const newP = await window.pocketai.saveProvider({
            id: '',
            type: selectedPreset.type,
            name: selectedPreset.label,
            baseUrl: selectedPreset.baseUrl,
            apiKeys: [apiKey.trim()],
            models: [],
            enabled: true,
            createdAt: Date.now(),
          })
          providerId = newP.id
        }
      } else {
        // 本地 provider（Ollama/LM Studio）— 只要 ensure 存在
        const existing = providers.find((p) => p.baseUrl === selectedPreset.baseUrl)
        if (existing) {
          providerId = existing.id
        } else {
          const newP = await window.pocketai.saveProvider({
            id: '',
            type: selectedPreset.type,
            name: selectedPreset.label,
            baseUrl: selectedPreset.baseUrl,
            apiKeys: [],
            models: [],
            enabled: true,
            createdAt: Date.now(),
          })
          providerId = newP.id
        }
      }
      setSavedProviderId(providerId)

      // 2. 把 assistant 绑定到刚保存的 provider
      const assistant = assistants.find((a) => a.id === selectedAssistantId)
      if (assistant && !assistant.defaultProviderId) {
        await window.pocketai.saveAssistant({
          ...assistant,
          defaultProviderId: providerId,
        })
      }
      // 3. pin 选中的助手
      await window.pocketai.setAssistantPinned(selectedAssistantId, true)

      // 4. 自动启用前 3 个内置 skill（轻量，让新用户开箱有技能）
      const skills = await window.pocketai.listSkills().catch(() => [])
      const builtinSkills = skills.filter((s) => s.isBuiltin).slice(0, 3)
      for (const sk of builtinSkills) {
        if (!sk.enabled) {
          await window.pocketai.saveSkill({ ...sk, enabled: true })
        }
      }
    } catch (e: any) {
      setSetupErr(e?.message ?? t('common.unknownError'))
      return
    } finally {
      setBusy(false)
    }
    return true // 成功
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
      setEncStatus({ ...(encStatus ?? { mode: 'none' as const }), mode: 'db' } as EncryptionStatus)
    } catch (e: any) {
      setEncErr(e?.message ?? t('enc.fail'))
    } finally {
      setBusy(false)
    }
  }

  async function handleNextStep1() {
    const ok = await saveProviderAndAssistant()
    if (ok) setStep((s) => s + 1)
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
          hardware.disk.removable ? t('wizard.removable') : '',
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

  // ─── 完整向导（3 步） ───
  // 从 PRESETS 里筛出向导优先展示的
  const wizardPresets = WIZARD_PRESET_LABELS.map((lbl) =>
    PROVIDER_PRESETS.find((p) => p.label === lbl)
  ).filter(Boolean) as typeof PROVIDER_PRESETS

  const builtinAssistants = assistants.filter((a) => a.isBuiltin)

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

      {/* ── Step 0: Welcome + Hardware ── */}
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
          {recommendation && (
            <div className="mt-3 rounded-lg border border-[var(--color-border)] p-3 text-[12px]">
              <span className="text-[var(--color-accent)] font-medium">{recommendation.tier}</span>
              <span className="text-[var(--color-text-muted)]"> — {recommendation.summary}</span>
            </div>
          )}
        </>
      )}

      {/* ── Step 1: Quick Setup ── */}
      {step === 1 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.setupTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.setupSubtitle')}
          </p>

          {/* A. Provider 选择 */}
          <div className="mb-4">
            <label className="text-[12px] text-[var(--color-text)] font-medium block mb-2">
              {t('wizard.providerLabel')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {wizardPresets.map((p) => {
                const active = selectedPreset?.label === p.label
                return (
                  <button
                    key={p.label}
                    onClick={() => {
                      setSelectedPreset(p)
                      setSetupErr('')
                    }}
                    className={`px-3 py-2 rounded-lg border text-[12px] text-left transition-colors ${
                      active
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                        : 'border-[var(--color-border)] hover:border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)] text-[var(--color-text)]'
                    }`}
                  >
                    <div className="font-medium">{p.label}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                      {p.needKey ? t('wizard.needKey') : t('wizard.localNoKey')}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* B. API Key 输入 / Ollama 引导 */}
          {selectedPreset?.needKey ? (
            <div className="mb-4">
              <label className="text-[12px] text-[var(--color-text)] font-medium block mb-1">
                {t('wizard.apiKeyLabel')}
              </label>
              <input
                type="password"
                className="input w-full"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('wizard.apiKeyPh', { p: selectedPreset!.label })}
                disabled={busy}
              />
              <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                {t('wizard.apiKeyHint')}
              </p>
            </div>
          ) : selectedPreset && (selectedPreset.type === 'ollama') ? (
            <div className="mb-4">
              <label className="text-[12px] text-[var(--color-text)] font-medium block mb-2">
                {t('wizard.localSetupLabel')}
              </label>
              <OllamaPanel compact />
            </div>
          ) : null}

          {/* C. Assistant 选择 */}
          <div className="mb-2">
            <label className="text-[12px] text-[var(--color-text)] font-medium block mb-2">
              {t('wizard.assistantLabel')}
            </label>
            {builtinAssistants.length === 0 ? (
              <div className="text-[11px] text-[var(--color-text-muted)] py-2 text-center">
                {t('common.loading')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {builtinAssistants.map((a) => {
                  const active = selectedAssistantId === a.id
                  return (
                    <button
                      key={a.id}
                      onClick={() => setSelectedAssistantId(a.id)}
                      className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                        active
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-hover-overlay)]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-base leading-none">{a.avatar || '🤖'}</span>
                        <span className="text-[12px] font-medium text-[var(--color-text)] truncate">
                          {a.name}
                        </span>
                      </div>
                      {a.description && (
                        <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
                          {a.description}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {setupErr && <div className="text-[11px] text-[var(--color-danger)] mt-2">{setupErr}</div>}
        </>
      )}

      {/* ── Step 2: Done + 加密可选 ── */}
      {step === 2 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.doneTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.doneSubtitle')}
          </p>

          {/* 配置摘要 */}
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-[11px] space-y-1.5 mb-4">
            {savedProviderId && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-text-muted)]">{t('wizard.summaryProvider')}:</span>
                <span className="font-mono text-[var(--color-success)]">
                  ✓ {providers.find((p) => p.id === savedProviderId)?.name ?? ''}
                </span>
              </div>
            )}
            {selectedAssistantId && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-text-muted)]">{t('wizard.summaryAssistant')}:</span>
                <span className="text-[var(--color-success)]">
                  ✓ {assistants.find((a) => a.id === selectedAssistantId)?.name ?? ''}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[var(--color-text-muted)]">{t('wizard.summarySkills')}:</span>
              <span className="text-[var(--color-success)]">✓ {t('wizard.summarySkillsAuto')}</span>
            </div>
          </div>

          {/* 加密卡片（可选） */}
          {encStatus?.mode === 'db' ? (
            <div className="rounded-lg border border-[var(--color-success)] p-3 text-[12px] text-[var(--color-success)]">
              ✅ {t('wizard.encAlready')}
            </div>
          ) : encDone ? (
            <div className="rounded-lg border border-[var(--color-success)] p-3 text-[12px] text-[var(--color-success)]">
              ✅ {t('wizard.encDone')}
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">
                {t('wizard.encDoneHint')}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-[12px] text-[var(--color-text)] font-medium mb-1">
                🔐 {t('wizard.encOptionalTitle')}
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mb-2">
                {t('wizard.encOptionalHint')}
              </p>
              {isPortable && (
                <p className="unlock-recovery-warn mb-2 text-[11px]">{t('wizard.portableEncWarn')}</p>
              )}
              {pwd.length === 0 ? (
                <div className="flex gap-2">
                  <input
                    type="password"
                    className="input flex-1"
                    value={pwd}
                    onChange={(e) => setPwd(e.target.value)}
                    placeholder={t('unlock.phNewPwd')}
                    disabled={busy}
                  />
                  <input
                    type="password"
                    className="input flex-1"
                    value={pwd2}
                    onChange={(e) => setPwd2(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void enableEncryption()}
                    placeholder={t('unlock.phConfirm')}
                    disabled={busy}
                  />
                </div>
              ) : null}
              {encErr && <div className="text-[11px] text-[var(--color-danger)] mt-2">{encErr}</div>}
              <div className="flex justify-end gap-2 mt-2">
                {pwd.length > 0 && (
                  <button className="btn-primary" disabled={busy} onClick={enableEncryption}>
                    {busy ? t('common.processing') : t('wizard.encBtn')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 小贴士 */}
          {!encDone && encStatus?.mode !== 'db' && (
            <div className="rounded-lg bg-[var(--color-hover-overlay)] p-3 text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-3">
              {t('wizard.doneTips')}
            </div>
          )}
        </>
      )}

      {/* 底部操作 */}
      <div className="flex items-center justify-between mt-6">
        <button className="btn-ghost text-[12px]" disabled={busy} onClick={finish}>
          {t('wizard.skip')}
        </button>
        <div className="flex gap-2">
          {step < FULL_STEPS - 1 ? (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={step === 1 ? handleNextStep1 : () => setStep((s) => s + 1)}
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
