// 模型选择器（简化版）
// - Provider + 模型 合并为一个下拉（"Provider名 / 模型名"），减少控件数量
// - 对照模式收纳为一个不显眼的图标按钮，单模型时不占视觉重心
import React from 'react'
import type { ProviderRecord, ChatTarget } from '../../../../shared/types'
import { enabledModelsOf } from '../../../../shared/provider-models'
import { ModelPicker } from '../../components/ModelPicker'
import { useI18n } from '../../i18n'
import { hasUsableModel } from '../../utils/provider-pick'

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

  const addTarget = () => {
    const base = enabled[0]
    // 一家启用模型都没有时不新增 target：多出来的只会是一个空下拉 + 空 model 的目标，
    // 除了让 canSend 更不可能成立之外没有任何作用
    if (!base || !hasUsableModel(base)) return
    const usable = enabledModelsOf(base)
    const used = new Set(targets.map((t) => `${t.providerId}:${t.model}`))
    const candidate = usable.find((m) => !used.has(`${base.id}:${m}`))
    onChange([...targets, { providerId: base.id, model: candidate ?? usable[0] ?? '' }])
  }

  const removeTarget = (index: number) => {
    if (targets.length <= 1) return
    onChange(targets.filter((_, i) => i !== index))
  }

  const exitCompare = () => {
    onChange([targets[0]!])
  }

  // 空态三分（§5.4）：触发器上要区分「没配置」「没拉取」「没启用」
  const emptyText =
    enabled.length === 0
      ? t('ms.notConfigured')
      : enabled.some((p) => p.models.length > 0)
        ? t('ms.noEnabledModels')
        : t('ms.noModels')

  const handlePick = (index: number, providerId: string, model: string) => {
    onChange(targets.map((t, idx) => (idx === index ? { ...t, providerId, model } : t)))
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {/* 模式标识（极简） */}
      {compareMode && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] shrink-0">
          {t('ms.compare', { n: targets.length })}
        </span>
      )}

      {/* targets 为空（全部服务商都没启用模型）时保留一个触发器/提示，不整条栏消失（方案 §5.2） */}
      {targets.length === 0 && (
        <ModelPicker providers={providers} value="" disabled emptyText={emptyText} onChange={() => {}} />
      )}

      {targets.map((target, i) => (
        <div key={`${target.providerId}-${target.model}`} className="flex items-center gap-1">
          {/* 两级选择器（来源 → 型号）；空态三分文案由 emptyText 传给触发器 */}
          <ModelPicker
            providers={providers}
            value={combinedValue(target)}
            disabled={disabled}
            emptyText={emptyText}
            onChange={(providerId, model) => handlePick(i, providerId, model)}
          />
          {compareMode && (
            <button
              onClick={() => removeTarget(i)}
              disabled={disabled || targets.length <= 1}
              className="w-5 h-5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-hover-overlay)] disabled:opacity-20 text-xs shrink-0"
              title={t('ms.remove')}
              aria-label={t('ms.remove')}
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
          aria-label={t('ms.addAllTitle')}
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
