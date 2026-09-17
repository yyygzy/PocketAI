import React from 'react'
import type { ProviderRecord, ChatTarget } from '../../../../shared/types'
import { useI18n } from '../../i18n'

interface Props {
  providers: ProviderRecord[]
  targets: ChatTarget[]
  onChange: (targets: ChatTarget[]) => void
  disabled?: boolean
}

export const ModelSelector: React.FC<Props> = ({ providers, targets, onChange, disabled }) => {
  const { t } = useI18n()
  const enabled = providers.filter((p) => p.enabled)
  const compareMode = targets.length > 1

  const updateTarget = (index: number, patch: Partial<ChatTarget>) => {
    onChange(targets.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  const handleProvider = (index: number, providerId: string) => {
    const p = enabled.find((x) => x.id === providerId)
    updateTarget(index, { providerId, model: p?.models[0] ?? '' })
  }

  const addTarget = () => {
    const base = enabled[0]
    if (!base) return
    // 默认选一个与现有不同的模型（若可用）
    const usedModels = new Set(targets.map((t) => `${t.providerId}:${t.model}`))
    const candidate = base.models.find((m) => !usedModels.has(`${base.id}:${m}`))
    onChange([...targets, { providerId: base.id, model: candidate ?? base.models[0] ?? '' }])
  }

  const removeTarget = (index: number) => {
    if (targets.length <= 1) return
    onChange(targets.filter((_, i) => i !== index))
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] shrink-0">
        {compareMode ? t('ms.compare', { n: targets.length }) : t('ms.single')}
      </span>

      {targets.map((target, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            className="select-mini"
            value={target.providerId}
            disabled={disabled}
            onChange={(e) => handleProvider(i, e.target.value)}
            title={t('ms.provider')}
          >
            {enabled.length === 0 && <option value="">{t('ms.notConfigured')}</option>}
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {(() => {
            const p = enabled.find((x) => x.id === target.providerId)
            return p && p.models.length > 0 ? (
              <select
                className="select-mini"
                value={target.model}
                disabled={disabled}
                onChange={(e) => updateTarget(i, { model: e.target.value })}
                title={t('ms.model')}
              >
                {p.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input-mini"
                value={target.model}
                disabled={disabled}
                onChange={(e) => updateTarget(i, { model: e.target.value })}
                placeholder={t('ms.modelId')}
              />
            )
          })()}

          {compareMode && (
            <button
              onClick={() => removeTarget(i)}
              disabled={disabled || targets.length <= 1}
              className="w-5 h-5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-hover-overlay)] disabled:opacity-20 text-xs shrink-0"
              title={t('ms.remove')}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <button
        onClick={addTarget}
        disabled={disabled || enabled.length === 0}
        className="text-[11px] px-2 py-1 rounded border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30 shrink-0"
        title={t('ms.addAllTitle')}
      >
        {t('ms.addCompare')}
      </button>
    </div>
  )
}
