import React, { useCallback, useEffect, useState } from 'react'
import type { ProviderRecord, ProviderType } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { isIpcFail, hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { errText } from '../../utils/error'
import { useConfirm } from '../../components/ConfirmDialog'
import { isPlainRemoteHttp } from '../../../../shared/url-policy'
import { delegateKey, type DelegateCapabilityView } from '../../../../shared/delegate-capability'
import { DelegateCapabilityBadge, DELEGATE_CAPABILITY_LABEL_KEY, delegateNoticeText } from './DelegateCapabilityBadge'

export const PROVIDER_PRESETS: { label: string; type: ProviderType; baseUrl: string; needKey: boolean }[] = [
  // ── 海外主流 ──
  { label: 'OpenAI', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needKey: true },
  { label: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', needKey: true },
  { label: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', needKey: true },
  { label: 'Groq', type: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', needKey: true },
  { label: 'OpenRouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needKey: true },
  // ── 国内主流（OpenAI 兼容） ──
  { label: 'DeepSeek', type: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', needKey: true },
  { label: 'Moonshot 月之暗面', type: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', needKey: true },
  { label: '智谱 GLM', type: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', needKey: true },
  { label: '通义千问 阿里云', type: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needKey: true },
  { label: '火山方舟 豆包', type: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', needKey: true },
  { label: '硅基流动 SiliconFlow', type: 'openai-compatible', baseUrl: 'https://api.siliconflow.cn/v1', needKey: true },
  // ── 本地 ──
  { label: 'Ollama', type: 'ollama', baseUrl: 'http://localhost:11434/v1', needKey: false },
  { label: 'LM Studio', type: 'ollama', baseUrl: 'http://localhost:1234/v1', needKey: false }
]

function emptyProvider(): ProviderRecord {
  return {
    id: '',
    type: 'openai-compatible',
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKeys: [],
    models: [],
    enabled: true,
    createdAt: 0
  }
}

export const ProviderSettings: React.FC = () => {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [editing, setEditing] = useState<ProviderRecord | null>(null)
  const [keysText, setKeysText] = useState('')
  // 密钥框当前是掩码视图还是已揭示的明文（主进程列表只回掩码，见 handlers/providers.ts）
  const [keysRevealed, setKeysRevealed] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const { confirm, dialog } = useConfirm()
  // 委派能力判定（V4-Iter-142）：providerId::model → 判定；probingKey 记哪一台正在探
  const [caps, setCaps] = useState<Record<string, DelegateCapabilityView>>({})
  const [probingKey, setProbingKey] = useState('')
  /**
   * §271：两发挂载读的失败面。改前都是 `if (!hasIpcFailed(v)) 写 state`＝失败什么都不做——
   * 服务商那发让左栏摆「尚未配置，点击「新增」」（把通道故障演成"你一台都没配"），
   * 能力判定那发让每行模型后面那枚徽标整块不出现（演成"这台从没探过"，尽管判定早就存在库里）。
   * 这一屏没有任何"再点一下就重拉"的出口（保存／删台／取模型那几条会顺带重拉，但那是做完别的事之后）⇒ 各配一颗键。
   */
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  const [capsUnread, setCapsUnread] = useState<{ error?: string } | null>(null)

  const load = useCallback(
    () =>
      window.pocketai
        .listProviders()
        .then((v) => {
          if (hasIpcFailed(v)) {
            setProvidersUnread({ error: v.error })
            return
          }
          setProvidersUnread(null)
          setProviders(v)
        })
        .catch((e: unknown) => {
          setProvidersUnread({ error: errText(e, '') })
          logIpcError('providerSettings.list', e)
        }),
    []
  )
  useEffect(() => {
    load()
  }, [load])

  const loadCaps = useCallback(
    () =>
      window.pocketai
        .listDelegateCapabilities()
        .then((list) => {
          if (hasIpcFailed(list)) {
            setCapsUnread({ error: list.error })
            return
          }
          setCapsUnread(null)
          setCaps(Object.fromEntries(list.map((e) => [e.key, e])))
        })
        .catch((e: unknown) => {
          setCapsUnread({ error: errText(e, '') })
          logIpcError('providerSettings.listDelegateCaps', e)
        }),
    []
  )
  useEffect(() => {
    loadCaps()
  }, [loadCaps])

  /**
   * 探一台模型（默认 3 发真请求，只走原生 tools 路径）。
   * error 不为空时**不许**写成"这台不行"——那可能是连不上或样本不足，判定保持原样（见探针侧的同一条规矩）。
   */
  const probeModel = async (model: string): Promise<void> => {
    const pid = editing?.id ?? ''
    if (!pid) {
      setNotice({ ok: false, text: t('provider.capSaveFirst') })
      return
    }
    const key = delegateKey(pid, model)
    setProbingKey(key)
    try {
      const r = await window.pocketai.probeDelegateCapability(pid, model)
      if (hasIpcFailed(r)) {
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
      } else if (r.error) {
        // 152：主进程回的是**码**（拒探 / 探测没跑完），句子由这里按当前语言拼
        setNotice({ ok: false, text: delegateNoticeText(t, r.error, t('common.unknownError')) })
      } else {
        setNotice({ ok: true, text: `${model}：${t(DELEGATE_CAPABILITY_LABEL_KEY[r.entry.capability])}` })
      }
      await loadCaps()
    } catch (e) {
      setNotice({ ok: false, text: errText(e) })
    } finally {
      setProbingKey('')
    }
  }

  /**
   * §246：停掉这一台正在跑的那一发。两种结果都要有脸：
   *  · `stopped:false` = 主进程说没这一发（比如另一扇窗口里它已经跑完）⇒ 不许假装「已停止」；
   *  · 停成功时那一发的 promise 会带着 `probe_aborted` 回来，句子由 probeModel 那条分支按当前语言拼。
   */
  const stopProbe = async (model: string): Promise<void> => {
    const pid = editing?.id ?? ''
    if (!pid) return
    try {
      const r = await window.pocketai.abortDelegateProbe(pid, model)
      if (hasIpcFailed(r)) {
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
        return
      }
      if (!r.stopped) setNotice({ ok: false, text: t('provider.probeNothingToStop') })
    } catch (e) {
      setNotice({ ok: false, text: errText(e) })
    }
  }

  /**
   * 开/关这台模型的顺序委派（决策③：默认关，用户点名才开）。
   * 前置条件（必须是"可当管控者"且未过期、不得开着文本协议）只在主进程判一次，
   * 这里照实显示拒绝原因——不许界面先把勾打上再让引擎偷偷不认。
   */
  const toggleDelegation = async (model: string, on: boolean): Promise<void> => {
    const pid = editing?.id ?? ''
    if (!pid) {
      setNotice({ ok: false, text: t('provider.capSaveFirst') })
      return
    }
    try {
      const r = await window.pocketai.setAgentDelegateEnabled(pid, model, on)
      // 业务拒绝与 safeHandle 失败仍是同一个形状（`ok:false` + error），一条分支就够（139 那条教训没变）；
      // 152 起两者只有 error 的**类型**不同：业务拒绝是码、IPC 层拒绝是字符串 ⇒ 分流交给 delegateNoticeText
      if (!r.ok) {
        setNotice({ ok: false, text: delegateNoticeText(t, r.error, t('common.unknownError')) })
      } else {
        setNotice({ ok: true, text: on ? t('provider.capDelegationOn') : t('provider.capDelegationOff') })
        await loadCaps()
      }
    } catch (e) {
      setNotice({ ok: false, text: errText(e) })
    }
  }

  const startEdit = (p: ProviderRecord | null) => {
    const rec = p ? { ...p } : emptyProvider()
    setEditing(rec)
    setKeysText(rec.apiKeys.join('\n'))
    setKeysRevealed(false)
    setNotice(null)
  }

  /**
   * 点快捷预设 = 开始配一家**新**服务商，而不是"把当前这条改指向另一个端点"。
   * 沿用正在编辑的那条会留下 A 家的名字 + B 家的 URL + A 家的 Key 与模型，
   * 保存后等于把 A 家的密钥发给 B 家（且用户以为自己在配 B）。
   */
  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]) => {
    setEditing({ ...emptyProvider(), type: preset.type, baseUrl: preset.baseUrl, name: preset.label })
    setKeysText('')
    setKeysRevealed(false)
    setNotice(null)
  }

  /** 从缓存模型里摘掉一条（保存后才落库：与表单其余字段同一套生效时机） */
  const removeModel = (m: string) => {
    setEditing((cur) => (cur ? { ...cur, models: cur.models.filter((x) => x !== m) } : cur))
  }

  // 用户显式点击才取回明文：单条查询，不改变「列表不落明文」的默认
  const handleRevealKeys = async () => {
    if (!editing?.id) {
      setNotice({ ok: false, text: t('provider.saveFirst') })
      return
    }
    try {
      const r = await window.pocketai.revealProviderKeys(editing.id)
      // 同一条合同：失败是 {ok:false}。旧写法会把失败当成"取到了空密钥"，
      // 结果是明文框显示为空并翻成"已显示"状态——**静默假成功**比报错更难查。
      if (hasIpcFailed(r)) {
        setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
        return
      }
      setKeysText((r.apiKeys ?? []).join('\n'))
      setKeysRevealed(true)
    } catch (e) {
      setNotice({ ok: false, text: errText(e) })
    }
  }

  const handleSave = async () => {
    if (!editing) return
    if (!editing.name.trim() || !editing.baseUrl.trim()) {
      setNotice({ ok: false, text: t('provider.nameUrlRequired') })
      return
    }
    const baseUrl = editing.baseUrl.trim()
    // 非回环 http 会把 API Key 与整段上下文裸奔在链路上，需用户显式确认后才落库
    if (isPlainRemoteHttp(baseUrl) && !(await confirm({ message: t('provider.plainHttpWarn'), danger: true }))) {
      return
    }
    const toSave: ProviderRecord = {
      ...editing,
      baseUrl,
      apiKeys: keysText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    const saved = await window.pocketai.saveProvider(toSave)
    // B1：未设主密码时主进程拒存新 Key（返回结构化失败，不是异常）
    if (isIpcFail(saved)) {
      setNotice({ ok: false, text: ipcFailText(saved, t('common.unknownError')) })
      return
    }
    setNotice({ ok: true, text: t('provider.saved', { name: saved.name }) })
    await load()
    setEditing(saved)
    // 保存后回到掩码视图（saved.apiKeys 已是掩码），避免明文长期停留在表单里
    setKeysText(saved.apiKeys.join('\n'))
    setKeysRevealed(false)
  }

  const handleFetchModels = async () => {
    if (!editing || !editing.id) {
      setNotice({ ok: false, text: t('provider.saveFirst') })
      return
    }
    setNotice({ ok: true, text: t('provider.fetching') })
    try {
      const models = await window.pocketai.fetchModels(editing.id)
      // safeHandle 的失败是**返回值不是 rejection**：这条通道成功时返回 string[]，失败时是 {ok:false,error}。
      // 不判形状就把对象写进 editing.models，下一帧 `editing.models.map()` 直接抛 ⇒ **整个应用白屏**
      // （B78 真 Electron 自测就是这么撞到的：一个"拉取模型失败"把界面抹平了）。
      if (!Array.isArray(models)) {
        const why = hasIpcFailed(models) ? ipcFailText(models, t('common.unknownError')) : t('common.unknownError')
        setNotice({ ok: false, text: t('provider.fetchFail', { e: why }) })
        return
      }
      setEditing({ ...editing, models })
      setNotice({ ok: true, text: t('provider.fetchOk', { n: models.length }) })
      await load()
    } catch (e) {
      setNotice({ ok: false, text: t('provider.fetchFail', { e: errText(e) }) })
    }
  }

  const handleTest = async () => {
    if (!editing?.id) return
    setNotice({ ok: true, text: t('provider.testing') })
    const r = await window.pocketai.testProvider(editing.id)
    setNotice(r.ok ? { ok: true, text: t('provider.testOk', { n: r.modelCount ?? 0 }) } : { ok: false, text: t('provider.testFail', { e: r.error ?? t('common.unknownError') }) })
  }

  const handleDelete = async () => {
    if (!editing?.id) return
    const r = await window.pocketai.deleteProvider(editing.id)
    // 旧写法 await 完就当成功：删不掉也报「已删除」并清空编辑态（139 那一族的第三种形状）
    if (hasIpcFailed(r)) {
      setNotice({ ok: false, text: ipcFailText(r, t('common.unknownError')) })
      return
    }
    setEditing(null)
    setNotice({ ok: true, text: t('provider.deleted') })
    await load()
  }

  return (
    <div className="flex gap-4 h-full">
      {/* 左侧 Provider 列表 */}
      <div className="w-60 shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">{t('provider.title')}</h3>
          <button
            onClick={() => startEdit(null)}
            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('provider.add')}
          </button>
        </div>
        <div className="space-y-1 overflow-y-auto">
          {/* §271：读不到就不摆「尚未配置，点击「新增」」那张脸（它说的正是"你一台都没配"） */}
          {providersUnread && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1">
              <LoadFailNotice what={t('common.providersList')} msg={ipcFailText(providersUnread, t('common.unknownError'))} />
              <button
                data-testid="provider-settings-providers-retry"
                className="text-xs underline text-[var(--color-text-muted)]"
                onClick={() => void load()}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
          {providers.length === 0 && !providersUnread && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('provider.empty')}</p>
          )}
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => startEdit(p)}
              className={`w-full text-left px-3 py-2 rounded text-sm ${
                editing?.id === p.id ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]' : 'hover:bg-[var(--color-hover-overlay)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${p.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]'}`} />
                <span className="truncate">{p.name}</span>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate mt-0.5">
                {t('provider.nModels', { n: p.models.length })}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 右侧编辑表单 */}
      <div className="flex-1 overflow-y-auto">
        {!editing ? (
          <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
            {t('provider.selectPrompt')}
          </div>
        ) : (
          <div className="max-w-xl space-y-4">
            {/* 预设 */}
            <div>
              <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('provider.presets')}</label>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => applyPreset(preset)}
                    className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    title={preset.needKey ? t('provider.needKey') : t('provider.noKey')}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <Field label={t('provider.f.name')}>
              <input
                className="input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder={t('provider.f.namePh')}
              />
            </Field>

            <Field label={t('provider.f.type')}>
              <select
                className="input"
                value={editing.type}
                onChange={(e) => setEditing({ ...editing, type: e.target.value as ProviderType })}
              >
                <option value="openai-compatible">{t('provider.f.type1')}</option>
                <option value="ollama">{t('provider.f.type2')}</option>
              </select>
            </Field>

            <Field label="Base URL">
              <input
                className="input font-mono text-xs"
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              />
            </Field>

            <Field label={t('provider.f.key')}>
              <textarea
                className="input font-mono text-xs min-h-[80px]"
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
                placeholder="sk-..."
              />
              <div className="flex items-center gap-2 mt-1">
                {editing.id && editing.apiKeys.length > 0 && !keysRevealed ? (
                  <button
                    onClick={handleRevealKeys}
                    className="chip chip-accent"
                    title={t('provider.revealHint')}
                  >
                    {t('provider.revealKeys')}
                  </button>
                ) : null}
                {editing.apiKeys.length > 0 && !keysRevealed ? (
                  <span className="text-[11px] text-[var(--color-text-muted)]">{t('provider.keysMasked')}</span>
                ) : null}
              </div>
            </Field>

            <Field label={t('provider.f.cached', { n: editing.models.length })}>
              {/* §271：那一读失败时每行模型后面那枚徽标整块不出现＝把"读不到判定"演成"这台从没探过"（判定其实存在库里）。
                  那颗「探测能否派活」不是这一发的出口（它是三发真请求，不是重读清单）⇒ 这里给一颗自己的键 */}
              {capsUnread && (
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <LoadFailNotice what={t('common.capabilityVerdicts')} msg={ipcFailText(capsUnread, t('common.unknownError'))} />
                  <button
                    data-testid="provider-settings-caps-retry"
                    className="text-xs underline text-[var(--color-text-muted)]"
                    onClick={loadCaps}
                  >
                    {t('agent.retryRead')}
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-2 rounded bg-[var(--color-input-bg)] border border-[var(--color-border)]">
                {editing.models.length === 0 ? (
                  <span className="text-xs text-[var(--color-text-muted)]">{t('provider.noCached')}</span>
                ) : (
                  editing.models.map((m) => (
                    <span
                      key={m}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] font-mono inline-flex items-center gap-1"
                    >
                      {m}
                      <button
                        type="button"
                        onClick={() => removeModel(m)}
                        title={t('provider.removeModel')}
                        aria-label={`${t('provider.removeModel')}: ${m}`}
                        className="opacity-50 hover:opacity-100 leading-none"
                      >
                        ✕
                      </button>
                      {editing.id && (
                        <DelegateCapabilityBadge
                          entry={caps[delegateKey(editing.id, m)]}
                          probing={probingKey === delegateKey(editing.id, m)}
                          onProbe={() => {
                            void probeModel(m)
                          }}
                          onStopProbe={() => {
                            void stopProbe(m)
                          }}
                          onToggleDelegation={(on) => {
                            void toggleDelegation(m, on)
                          }}
                        />
                      )}
                    </span>
                  ))
                )}
              </div>
            </Field>

            {notice && <Notice ok={notice.ok} text={notice.text} />}
            {dialog}

            <div className="flex gap-2 pt-2">
              <button onClick={handleSave} className="btn-primary">{t('common.save')}</button>
              <button onClick={handleFetchModels} className="btn-ghost">{t('provider.fetch')}</button>
              <button onClick={handleTest} className="btn-ghost">{t('provider.test')}</button>
              {editing.id && (
                <button onClick={handleDelete} className="btn-ghost text-[var(--color-danger)] ml-auto">
                  {t('common.delete')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-xs text-[var(--color-text-muted)] mb-1">{label}</label>
    {children}
  </div>
)

export const Notice: React.FC<{ ok: boolean; text: string }> = ({ ok, text }) => (
  <div className={`text-xs px-3 py-2 rounded ${ok ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'}`}>
    {text}
  </div>
)
