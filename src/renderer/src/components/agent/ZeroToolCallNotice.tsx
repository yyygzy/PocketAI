// 零调用提示：有工具可用、模型这一轮却一次都没调用时才出现。
// 两条「为什么」互斥（判定在 agent-shared 的 zeroCallNoticeFlags，便于单测）：
// 已知有 MCP 工具被 `'*'` 挡下时只说被挡——那时更可能的原因是授权，不是端点。
import React from 'react'
import { useI18n } from '../../i18n'
import { zeroCallNoticeFlags } from './agent-shared'
import {
  toolFailureText,
  toolReasonText,
  toolTierText,
  type ToolCapabilityView,
  type ToolProbeFailure
} from '../../../../shared/tool-capability'

interface Props {
  mcpHeldBack: number
  providerId: string
  model: string
  textProtocolForced: boolean
  onClose: () => void
  onEnableTextProtocol: () => void
  /** P0-4b：这台模型的工具调用判定（没有就不摆这一段） */
  capability?: ToolCapabilityView | null
  probing?: boolean
  probeFailure?: ToolProbeFailure | null
  probeIpcError?: string
  onProbe?: () => void
  onStopProbe?: () => void
  onSkipProbe?: () => void
}

export const ZeroToolCallNotice: React.FC<Props> = ({
  mcpHeldBack,
  providerId,
  model,
  textProtocolForced,
  onClose,
  onEnableTextProtocol,
  capability,
  probing,
  probeFailure,
  probeIpcError,
  onProbe,
  onStopProbe,
  onSkipProbe
}) => {
  const { t } = useI18n()
  const flags = zeroCallNoticeFlags({ mcpHeldBack, providerId, model, textProtocolForced })
  // 四档只提示、不阻断：这一段永远不挡发送，也不置灰工具入口。
  // 「可用」不在这里重复夸一遍——零调用提示本身已经够长了。
  const showCapability =
    !!probing || !!probeFailure || !!probeIpcError || (!!capability && capability.tier !== 'usable')
  const failureText = probeFailure ? toolFailureText(t, probeFailure, '') : ''
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
      {showCapability && (
        <div className="mt-1 pl-6" data-testid="zero-tool-capability">
          <div className="text-[var(--color-text-muted)]">
            <span>{t('common.toolCapabilityVerdicts')}：</span>
            <span className="text-[var(--color-text)]">
              {capability
                ? toolTierText(t, capability.tier)
                : probing
                  ? t('provider.toolCapProbing')
                  : t('provider.toolCapUnknown')}
            </span>
          </div>
          {capability && toolReasonText(t, capability) && (
            <div className="text-[var(--color-text-muted)]">{toolReasonText(t, capability)}</div>
          )}
          {capability?.stale && (
            <div className="text-[var(--color-text-muted)]">{t('provider.toolCapStale')}</div>
          )}
          {(failureText || probeIpcError) && (
            <div className="text-[var(--color-danger)]">{failureText || probeIpcError}</div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {probing ? (
              <button onClick={onStopProbe} className="text-[var(--color-text-muted)] hover:underline">
                {t('provider.toolCapStop')}
              </button>
            ) : (
              onProbe && (
                <button
                  onClick={onProbe}
                  title={t('provider.toolCapFee')}
                  className="text-left text-[var(--color-accent)] hover:underline"
                >
                  {t('provider.toolCapProbe')}
                </button>
              )
            )}
            {onSkipProbe && capability?.reason !== 'user_skipped' && (
              <button onClick={onSkipProbe} className="text-[var(--color-text-muted)] hover:underline">
                {t('toolCap.skipProbe')}
              </button>
            )}
            <span className="text-[10px] text-[var(--color-text-muted)]">{t('provider.toolCapFee')}</span>
          </div>
        </div>
      )}
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
