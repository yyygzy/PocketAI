// 模型选择器（简化版）
// - Provider + 模型 合并为一个下拉（"Provider名 / 模型名"），减少控件数量
// - 对照模式收纳为一个不显眼的图标按钮，单模型时不占视觉重心
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

  // 合并下拉的 value = "providerId:model"
  const combinedValue = (t: ChatTarget) => `${t.providerId}:${t.model}`

  const handleCombinedChange = (index: number, value: string) => {
    const i = value.indexOf(':')
    if (i <= 0) return
    const providerId = value.slice(0, i)
    const model = value.slice(i + 1)
    onChange(targets.map((t, idx) => (idx === index ? { ...t, providerId, model } : t)))
  }

  const addTarget = () => {
    const base = enabled[0]
    if (!base) return
    const used = new Set(targets.map((t) => `${t.providerId}:${t.model}`))
    const candidate = base.models.find((m) => !used.has(`${base.id}:${m}`))
    onChange([...targets, { providerId: base.id, model: candidate ?? base.models[0] ?? '' }])
  }

  const removeTarget = (index: number) => {
    if (targets.length <= 1) return
    onChange(targets.filter((_, i) => i !== index))
  }

  const exitCompare = () => {
    onChange([targets[0]])
  }

  // 扁平化所有可选模型：Provider名 / 模型名
  const options = enabled.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.id}:${m}`, label: `${p.name} / ${m}` }))
  )

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* 模式标识（极简） */}
      {compareMode && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] shrink-0">
          {t('ms.compare', { n: targets.length })}
        </span>
      )}

      {targets.map((target, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            className="select-mini min-w-[140px]"
            value={combinedValue(target)}
            disabled={disabled}
            onChange={(e) => handleCombinedChange(i, e.target.value)}
          >
            {enabled.length === 0 && <option value="">{t('ms.notConfigured')}</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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

      {/* 对照模式收纳为图标按钮 */}
      {!compareMode ? (
        <button
          onClick={addTarget}
          disabled={disabled || enabled.length === 0}
          className="w-7 h-7 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30 shrink-0 flex items-center justify-center"
          title={t('ms.addAllTitle')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <button
          onClick={exitCompare}
          disabled={disabled}
          className="text-[10px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] shrink-0"
          title={t('ms.exitCompare')}
        >
          {t('ms.exitCompare')}
        </button>
      )}
    </div>
  )
}
