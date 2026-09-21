import React, { useEffect, useState } from 'react'
import type { ProviderRecord, ProviderType } from '../../../../shared/types'
import { useI18n } from '../../i18n'

const PRESETS: { label: string; type: ProviderType; baseUrl: string; needKey: boolean }[] = [
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
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => window.pocketai.listProviders().then(setProviders)
  useEffect(() => {
    load()
  }, [])

  const startEdit = (p: ProviderRecord | null) => {
    const rec = p ? { ...p } : emptyProvider()
    setEditing(rec)
    setKeysText(rec.apiKeys.join('\n'))
    setNotice(null)
  }

  const handleSave = async () => {
    if (!editing) return
    if (!editing.name.trim() || !editing.baseUrl.trim()) {
      setNotice({ ok: false, text: t('provider.nameUrlRequired') })
      return
    }
    const toSave: ProviderRecord = {
      ...editing,
      apiKeys: keysText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    const saved = await window.pocketai.saveProvider(toSave)
    setNotice({ ok: true, text: t('provider.saved', { name: saved.name }) })
    await load()
    setEditing(saved)
  }

  const handleFetchModels = async () => {
    if (!editing || !editing.id) {
      setNotice({ ok: false, text: t('provider.saveFirst') })
      return
    }
    setNotice({ ok: true, text: t('provider.fetching') })
    try {
      const models = await window.pocketai.fetchModels(editing.id)
      setEditing({ ...editing, models })
      setNotice({ ok: true, text: t('provider.fetchOk', { n: models.length }) })
      await load()
    } catch (e) {
      setNotice({ ok: false, text: t('provider.fetchFail', { e: (e as Error).message }) })
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
    await window.pocketai.deleteProvider(editing.id)
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
          {providers.length === 0 && (
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
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        type: preset.type,
                        baseUrl: preset.baseUrl,
                        name: editing.name || preset.label
                      })
                    }
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
            </Field>

            <Field label={t('provider.f.cached', { n: editing.models.length })}>
              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-2 rounded bg-[var(--color-input-bg)] border border-[var(--color-border)]">
                {editing.models.length === 0 ? (
                  <span className="text-xs text-[var(--color-text-muted)]">{t('provider.noCached')}</span>
                ) : (
                  editing.models.map((m) => (
                    <span key={m} className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] font-mono">
                      {m}
                    </span>
                  ))
                )}
              </div>
            </Field>

            {notice && <Notice ok={notice.ok} text={notice.text} />}

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
