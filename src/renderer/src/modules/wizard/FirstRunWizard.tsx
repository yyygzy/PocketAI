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
import { logIpcError, reportIpcError, isIpcFail, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { formatBytes } from '../../utils/format'
import { NEW_MASTER_PASSWORD_MIN } from '../../../../shared/schemas/encryption'
import { PROVIDER_PRESETS } from '../settings/ProviderSettings'
import { modelRecKey } from '../../../../shared/model-rec-codes'
import { DELEGATE_CAPABILITY_LABEL_KEY, delegateNoticeText } from '../settings/DelegateCapabilityBadge'
import type { DelegateProbeResult } from '../../../../shared/delegate-capability'
import type {
  HardwareInfo,
  ModelRecommendation,
  EncryptionStatus,
  ProviderRecord,
  AssistantRecord,
  ProviderType,
} from '../../../../shared/types'

export type WizardVariant = 'full' | 'recheck'

const FULL_STEPS = 4

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
  // B1 闸门触发后开放「回安全步设主密码」的入口（配置步内专用）
  const [jumpToSecurity, setJumpToSecurity] = useState(false)
  // 存下的整条 provider 记录（147 起完成页的可选探针要用它的 models；只存 id 会看不出有没有缓存模型）
  const [savedProvider, setSavedProvider] = useState<ProviderRecord | null>(null)
  // 首启探针（V4-Iter-147）：可选、可跳过、失败不阻塞完成
  const [probeModel, setProbeModel] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeOut, setProbeOut] = useState<DelegateProbeResult | null>(null)
  const [probeErr, setProbeErr] = useState('')
  const [probeSkipped, setProbeSkipped] = useState(false)

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
      .catch(reportIpcError('wizard.getHardwareInfo'))
    window.pocketai.getEncryptionStatus().then(setEncStatus).catch(reportIpcError('wizard.getEncryptionStatus'))
    // 模型推荐含一次 Ollama 端口探测，较轻，后台加载
    window.pocketai
      .recommendModels()
      .then((r) => {
        if (r.ok && r.data) setRecommendation(r.data)
      })
      .catch(reportIpcError('wizard.recommendModels'))

    // 加载已有 provider + assistant（向导 Step 1 用）
    window.pocketai.listProviders().then(setProviders).catch(reportIpcError('wizard.listProviders'))
    window.pocketai.listAssistants().then((list) => {
      setAssistants(list)
      // 默认选中第一个内置助手
      const firstBuiltin = list.find((a) => a.isBuiltin)
      if (firstBuiltin) setSelectedAssistantId(firstBuiltin.id)
    }).catch(reportIpcError('wizard.listAssistants'))
  }, [])

  async function finish() {
    setBusy(true)
    try {
      await window.pocketai.completeWizard()
    } catch (e) {
      // 标记失败不阻塞关闭（向导已完成，重启后仍会再弹，但不卡死用户）
      logIpcError('wizard.complete', e)
    }
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
      //   决定"要不要新建"之前**现取一次清单**：挂载时那份快照会过期——这一步之前用户可能刚在
      //   OllamaPanel 里拉完模型，而拉取成功会由主进程建好/追加这条 provider（`ipc/handlers/ollama.ts:52`）。
      //   拿旧快照判"没有"就会发一份 `models: []` 的"新建"载荷，把刚拉到的那台清空（V4-Iter-151 的根因）。
      //   取失败不致命：退回挂载时那一份继续走（向导是首启必经路，不许因为一次清单刷新失败把用户卡在这儿），
      //   repo 侧另有一道守护兜底（`provider.repo.ts` 的 foundByDedupe 那条）。
      let latest = providers
      try {
        latest = await window.pocketai.listProviders()
      } catch (e) {
        logIpcError('wizard.listProviders.refresh', e)
      }
      setProviders(latest)
      let saved: ProviderRecord
      if (selectedPreset.needKey) {
        const existing = latest.find((p) => p.baseUrl === selectedPreset.baseUrl)
        if (existing) {
          // 已有同 baseUrl 的 provider，追加新 key
          const updated = await window.pocketai.saveProvider({
            ...existing,
            apiKeys: [...existing.apiKeys, apiKey.trim()],
          })
          if (isIpcFail(updated)) {
            setSetupErr(ipcFailText(updated, t('common.unknownError')))
            return
          }
          saved = updated
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
          if (isIpcFail(newP)) {
            setSetupErr(ipcFailText(newP, t('common.unknownError')))
            return
          }
          saved = newP
        }
      } else {
        // 本地 provider（Ollama/LM Studio）— 只要 ensure 存在
        const existing = latest.find((p) => p.baseUrl === selectedPreset.baseUrl)
        if (existing) {
          saved = existing
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
          if (isIpcFail(newP)) {
            setSetupErr(ipcFailText(newP, t('common.unknownError')))
            return
          }
          saved = newP
        }
      }
      setSavedProvider(saved)
      const providerId = saved.id
      // 记录向导选中的 provider，供 ChatModule 初始化回填默认对话模型
      window.pocketai.setLastProvider(providerId).catch(reportIpcError('wizard.setLastProvider'))

      // 2. 把 assistant 绑定到刚保存的 provider
      //    内置助手只读，需先复制为「我的助手」再绑定 provider
      let effectiveAssistantId = selectedAssistantId
      const assistant = assistants.find((a) => a.id === selectedAssistantId)
      if (assistant) {
        let target = assistant
        if (assistant.isBuiltin) {
          target = await window.pocketai.duplicateAssistant(assistant.id)
          effectiveAssistantId = target.id
          setSelectedAssistantId(target.id)
          // 把副本加入本地列表，供后续摘要展示
          setAssistants((prev) => {
            if (prev.some((a) => a.id === target.id)) return prev
            return [...prev, target]
          })
        }
        if (!target.defaultProviderId) {
          await window.pocketai.saveAssistant({
            ...target,
            defaultProviderId: providerId,
          })
        }
      }
      // 3. pin 选中的助手（内置的 pin 副本）
      await window.pocketai.setAssistantPinned(effectiveAssistantId, true)

      // 4. 自动启用前 3 个内置 skill（轻量，让新用户开箱有技能）
      const skills = await window.pocketai.listSkills().catch(() => [])
      const builtinSkills = skills.filter((s) => s.isBuiltin).slice(0, 3)
      for (const sk of builtinSkills) {
        if (!sk.enabled) {
          await window.pocketai.saveSkill({ ...sk, enabled: true })
        }
      }
    } catch (e) {
      setSetupErr(errText(e, t('common.unknownError')))
      return
    } finally {
      setBusy(false)
    }
    return true // 成功
  }

  async function enableEncryption() {
    setEncErr('')
    if (pwd.length < NEW_MASTER_PASSWORD_MIN) return setEncErr(t('unlock.pwdTooShort'))
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
    } catch (e) {
      setEncErr(errText(e, t('enc.fail')))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 探针候选 = 这家 provider **已缓存**的模型。一家都没有 ⇒ 完成页整块不出现
   * （向导里不自动「拉取模型」，那是用户的事；缺数据时宁可不给这一格，也不摆个点了必错的按钮）。
   */
  const probeCandidates = (savedProvider?.models ?? []).filter((m) => typeof m === 'string' && m.trim() !== '')
  // 当前要测的那台按派生值走（候选换了就回落第一条），不为此再写一个 effect
  const activeProbeModel = probeCandidates.includes(probeModel) ? probeModel : (probeCandidates[0] ?? '')

  /**
   * 首启跑一次 142 探针（V4-Iter-147，用户 2026-10-16 选定"可选、可跳过、失败不阻塞"）。
   * 三条口径写在这儿而不是文案里：
   *  · **只在用户点名时发请求**（探针是 3 发真推理，跑在用户显存上，不许在挂载时自动跑）；
   *  · 失败只落 `probeErr`，不碰 `busy` ⇒ 「完成 / 跳过」始终可点，这就是"不阻塞"的实现方式；
   *  · `error` 不为空时**不许**写成"这台不行"（探针侧有传输失败就不下结论、也不改写旧判定），
   *    所以这里照实说"这次没测出结论"。
   */
  async function runProbe(): Promise<void> {
    if (!savedProvider || !activeProbeModel) return
    setProbing(true)
    setProbeErr('')
    try {
      const r = await window.pocketai.probeDelegateCapability(savedProvider.id, activeProbeModel)
      // 探针成功载荷是 {entry, error}，没有 ok ⇒ 必须用 hasIpcFailed（isIpcFail 会把成功读成失败，同 139）
      if (hasIpcFailed(r)) setProbeErr(ipcFailText(r, t('common.unknownError')))
      else {
        setProbeOut(r)
        // 152：`r.error` 是**码 + 数**（不是中文句子），句子在这儿按当前语言拼——
        // 这一格在首启、面向新用户，中英夹排比设置页更容易撞上（147 的真机自测就是这么发现的）
        if (r.error) setProbeErr(delegateNoticeText(t, r.error, t('common.unknownError')))
      }
    } catch (e) {
      setProbeErr(errText(e, t('common.unknownError')))
    } finally {
      setProbing(false)
    }
  }

  async function handleSetupNext() {
    // B1：主进程在明文模式下拒存任何新 API Key。这里先挡一道，是为了给出一条**当场能解决**的话
    // （而不是等 IPC 报错），并开放回跳到安全步——此时还没发生任何写入，回跳不会造成 Key 重复追加
    const needsMaster = encStatus?.mode !== 'db' && !encDone && !!selectedPreset?.needKey && !!apiKey.trim()
    if (needsMaster) {
      setSetupErr(t('wizard.keyNeedsMaster'))
      setJumpToSecurity(true)
      return
    }
    setJumpToSecurity(false)
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
            <span className="text-[var(--color-accent)] font-medium">{t(modelRecKey('tier', recommendation.tier))}</span>
            <span className="text-[var(--color-text-muted)]"> — {t(modelRecKey('summary', recommendation.summary), recommendation.summaryParams)}</span>
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
              <span className="text-[var(--color-accent)] font-medium">{t(modelRecKey('tier', recommendation.tier))}</span>
              <span className="text-[var(--color-text-muted)]"> — {t(modelRecKey('summary', recommendation.summary), recommendation.summaryParams)}</span>
            </div>
          )}
        </>
      )}

      {/* ── Step 1: 安全（放在填 Key 之前——B1 口径：未设主密码不保存任何新凭据） ── */}
      {step === 1 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.secTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.secSubtitle')}
          </p>
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
              {/* 两个框必须常驻：原先以 pwd.length === 0 为条件渲染，输一个字符就整块消失，
                  确认框再也填不上 ⇒ pwd2 恒为空 ⇒ 永远「两次输入不一致」，向导里设不了主密码 */}
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

        </>
      )}

      {/* ── Step 2: Quick Setup ── */}
      {step === 2 && (
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
                placeholder={t('wizard.apiKeyPh', { p: selectedPreset?.label ?? '' })}
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
              {/* B7：Ollama 安装在后台进行，用户可不必等待直接进入下一步 */}
              <button
                type="button"
                className="btn-ghost text-[11px] mt-2"
                disabled={busy}
                onClick={handleSetupNext}
              >
                {t('wizard.ollamaLater')}
              </button>
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
          {jumpToSecurity && (
            <button className="btn-ghost text-[11px] mt-2" onClick={() => setStep(1)}>
              {t('wizard.goSetMaster')}
            </button>
          )}
        </>
      )}

      {/* ── Step 3: Done ── */}
      {step === 3 && (
        <>
          <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">
            {t('wizard.doneTitle')}
          </h1>
          <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-4">
            {t('wizard.doneSubtitle')}
          </p>

          {/* 配置摘要 */}
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-[11px] space-y-1.5 mb-4">
            {savedProvider && (
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-text-muted)]">{t('wizard.summaryProvider')}:</span>
                <span className="font-mono text-[var(--color-success)]">✓ {savedProvider.name}</span>
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

          {/* 加密状态（设置主密码的入口已前移到 step 1） */}
          {encStatus?.mode === 'db' || encDone ? (
            <div className="rounded-lg border border-[var(--color-success)] p-3 text-[12px] text-[var(--color-success)]">
              ✅ {t('wizard.encDone')}
            </div>
          ) : (
            <div className="unlock-recovery-warn rounded-lg p-3 text-[11px] leading-relaxed">
              ⚠️ {t('wizard.doneEncOff')}
            </div>
          )}

          {/* 小贴士 */}
          {!encDone && encStatus?.mode !== 'db' && (
            <div className="rounded-lg bg-[var(--color-hover-overlay)] p-3 text-[11px] text-[var(--color-text-muted)] leading-relaxed mt-3">
              {t('wizard.doneTips')}
            </div>
          )}

          {/*
            首启探针（V4-Iter-147）：放在完成页**最末**——这一页的主信息是"配好了 + 加密状态"，
            这一格是顺手的可选项，不许挤在它前面。整块只在有缓存模型时出现，点「以后再说」就收起。
          */}
          {probeCandidates.length > 0 && !probeSkipped && (
            <div className="rounded-lg border border-[var(--color-border)] p-3 mt-3" data-probe-block>
              <div className="text-[12px] text-[var(--color-text)] font-medium mb-1">🧪 {t('wizard.probeTitle')}</div>
              <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed mb-2">
                {t('wizard.probeHint')}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {probeCandidates.length > 1 ? (
                  <label className="text-[11px] text-[var(--color-text-muted)]">
                    {t('wizard.probeModelLabel')}
                    <select
                      className="select-mini ml-2"
                      value={activeProbeModel}
                      disabled={probing}
                      onChange={(e) => setProbeModel(e.target.value)}
                    >
                      {probeCandidates.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="text-[11px] font-mono text-[var(--color-text)]">{activeProbeModel}</span>
                )}
                <button className="btn-primary text-[11px]" disabled={probing || busy} onClick={runProbe}>
                  {probing ? t('wizard.probeRunning') : t('wizard.probeBtn')}
                </button>
                <button className="btn-ghost text-[11px]" disabled={probing} onClick={() => setProbeSkipped(true)}>
                  {t('wizard.probeLater')}
                </button>
              </div>
              {probeErr && (
                <div className="text-[11px] text-[var(--color-danger)] mt-2 leading-relaxed" data-probe-error>
                  {t('wizard.probeFailed', { e: probeErr })}
                </div>
              )}
              {probeOut && !probeErr && (
                <div className="text-[11px] text-[var(--color-text)] mt-2 leading-relaxed" data-probe-verdict>
                  {t('wizard.probeVerdict', { label: t(DELEGATE_CAPABILITY_LABEL_KEY[probeOut.entry.capability]) })}
                  {/* 判定与开关是两件事（决策③：默认关、逐台点名）。这一句不许省，也不许写成"已开启" */}
                  <div className="text-[var(--color-text-muted)] mt-1">{t('wizard.probeNotEnabled')}</div>
                </div>
              )}
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
              onClick={step === 2 ? handleSetupNext : () => setStep((s) => s + 1)}
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
