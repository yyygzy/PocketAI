import React, { useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord, KnowledgeBase, ToolSchema, SkillRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'

interface Props {
  initial: Partial<AssistantRecord>
  providers: ProviderRecord[]
  onCancel: () => void
  onSaved: (a: AssistantRecord) => void
}

const VARIABLE_KEYS = ['ae.var.date', 'ae.var.time', 'ae.var.weekday', 'ae.var.user', 'ae.var.knowledge', 'ae.var.tools', 'ae.var.skills']

export const AssistantEditor: React.FC<Props> = ({ initial, providers, onCancel, onSaved }) => {
  const { t } = useI18n()
  const [avatar, setAvatar] = useState(initial.avatar ?? '🤖')
  const [name, setName] = useState(initial.name ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [welcomeMessage, setWelcomeMessage] = useState(initial.welcomeMessage ?? '')
  const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? '')
  const [providerId, setProviderId] = useState(initial.defaultProviderId ?? '')
  const [model, setModel] = useState(initial.defaultModel ?? '')
  const [kbIds, setKbIds] = useState<string[]>(initial.knowledgeBaseIds ?? [])
  const [skillIds, setSkillIds] = useState<string[]>(initial.skillIds ?? [])
  const [toolPermissions, setToolPermissions] = useState<string[]>(initial.toolPermissions ?? [])
  const [kbs, setKbs] = useState<KnowledgeBase[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [skills, setSkills] = useState<SkillRecord[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.pocketai.listKnowledgeBases().then(setKbs).catch(reportIpcError('assistantEditor.listKbs'))
    window.pocketai.listAvailableTools().then(setTools).catch(reportIpcError('assistantEditor.listTools'))
    window.pocketai.listSkills().then(setSkills).catch(reportIpcError('assistantEditor.listSkills'))
  }, [])

  const enabledProviders = providers.filter((p) => p.enabled)
  const provider = enabledProviders.find((p) => p.id === providerId)

  const toggleKb = (id: string) => {
    setKbIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleSkill = (id: string) => {
    setSkillIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleTool = (id: string) => {
    setToolPermissions((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }
  const toggleAllowAll = () => {
    setToolPermissions((prev) => (prev.includes('*') ? prev.filter((x) => x !== '*') : ['*']))
  }

  const chipCls = (on: boolean) =>
    `text-[11px] px-2 py-1 rounded border ${
      on
        ? 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]'
        : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
    }`

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('ae.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const saved = await window.pocketai.saveAssistant({
        ...(initial.id ? { id: initial.id } : {}),
        name: name.trim(),
        avatar: avatar.trim() || '🤖',
        description: description.trim(),
        welcomeMessage: welcomeMessage.trim(),
        systemPrompt,
        defaultProviderId: providerId || null,
        defaultModel: providerId && model ? model : null,
        knowledgeBaseIds: kbIds,
        skillIds,
        toolPermissions
      })
      onSaved(saved)
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="w-20 shrink-0">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.avatar')}</label>
          <input
            className="input text-center text-2xl"
            value={avatar}
            onChange={(e) => setAvatar(e.target.value)}
            maxLength={4}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.description')}</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.welcome')}</label>
        <input className="input" value={welcomeMessage} onChange={(e) => setWelcomeMessage(e.target.value)} />
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.defaultModel')}</label>
        <div className="flex gap-2">
          <select className="select-mini flex-1" value={providerId} onChange={(e) => { setProviderId(e.target.value); setModel('') }}>
            <option value="">{t('ae.followCurrent')}</option>
            {enabledProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {provider && provider.models.length > 0 && (
            <select className="select-mini flex-1" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t('ae.selectModel')}</option>
              {provider.models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">{t('ae.prompt')}</label>
        <textarea
          className="input font-mono text-xs min-h-[180px] leading-relaxed"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t('ae.promptPh')}
        />
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {VARIABLE_KEYS.map((vk) => (
            <span key={vk} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]">
              {t(vk)}
            </span>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.kbLabel')}
        </label>
        {kbs.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('ae.noKb')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {kbs.map((kb) => (
              <button
                key={kb.id}
                onClick={() => toggleKb(kb.id)}
                className={chipCls(kbIds.includes(kb.id))}
              >
                {kb.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.skillsLabel')}
        </label>
        {skills.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('ae.noSkills')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {skills.map((sk) => (
              <button
                key={sk.id}
                onClick={() => toggleSkill(sk.id)}
                title={sk.description}
                className={chipCls(skillIds.includes(sk.id))}
              >
                {sk.icon} {sk.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--color-text-muted)] mb-1">
          {t('ae.toolsLabel')}
        </label>
        <div className="flex flex-wrap gap-1.5 mb-1">
          <button onClick={toggleAllowAll} className={chipCls(toolPermissions.includes('*'))}>
            {t('ae.allowAll')}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tl) => (
            <button
              key={tl.id}
              onClick={() => toggleTool(tl.id)}
              disabled={toolPermissions.includes('*')}
              title={tl.description}
              className={`${chipCls(toolPermissions.includes('*') || toolPermissions.includes(tl.id))} ${
                toolPermissions.includes('*') ? 'opacity-60' : ''
              }`}
            >
              {tl.source === 'mcp' ? '🔌' : '⚡'} {tl.name}
            </button>
          ))}
          {tools.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('ae.noTools')}
            </p>
          )}
        </div>
      </div>

      {error && <div className="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 rounded">{error}</div>}

      <div className="flex gap-2 pt-1">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}
