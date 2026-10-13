// 零调用提示：有工具可用、模型这一轮却一次都没调用时才出现。
// 两条「为什么」互斥（判定在 agent-shared 的 zeroCallNoticeFlags，便于单测）：
// 已知有 MCP 工具被 `'*'` 挡下时只说被挡——那时更可能的原因是授权，不是端点。
import React from 'react'
import { useI18n } from '../../../i18n'
import { zeroCallNoticeFlags } from '../agent-shared'

interface Props {
  mcpHeldBack: number
  providerId: string
  model: string
  textProtocolForced: boolean
  onClose: () => void
  onEnableTextProtocol: () => void
}

export const ZeroToolCallNotice: React.FC<Props> = ({
  mcpHeldBack,
  providerId,
  model,
  textProtocolForced,
  onClose,
  onEnableTextProtocol
}) => {
  const { t } = useI18n()
  const flags = zeroCallNoticeFlags({ mcpHeldBack, providerId, model, textProtocolForced })
  return (
    <div className="mb-2 self-start w-full max-w-[640px] rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="shrink-0">⚠️</span>
        <span className="flex-1 text-[var(--color-text)]">{t('agent.noToolCallNotice')}</span>
        <button
          onClick={onClose}
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          title={t('common.close')}
        >
          ✕
        </button>
      </div>
      {flags.showHeldBack && (
        <p className="mt-1 pl-6 text-[var(--color-text-muted)]">
          {t('agent.mcpHeldBackHint', { count: mcpHeldBack })}
        </p>
      )}
      {flags.showSuggest && (
        <button
          onClick={onEnableTextProtocol}
          className="mt-1.5 pl-6 text-left text-[var(--color-accent)] hover:underline"
        >
          {t('agent.textProtocolSuggest')}
        </button>
      )}
    </div>
  )
}
