// 模型级徽标（P4 批次 0 迁移，唯一展示实现）：上下文窗口 / 备用模型链 / 文本协议。
//
// 原来这组徽标只在 Agent 壳的 `AgentModelBar` 里；对话壳顶栏要同一套能力，故把「徽标 + 小编辑器」
// 整段抽到这里：`AgentModelBar` 与对话壳 `ChatModelExtras` 都渲染本组件，不存在第二套徽标。
// 遮罩/拒绝话术与三态脸（未设 / 读不到 / 已设）逐字沿用原实现，未新增 i18n key。
import React, { useState } from 'react'
import type { ProviderRecord } from '../../../../shared/types'
import {
  DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS
} from '../../../../shared/model-window'
import { useI18n } from '../../i18n'
import type { AgentModelExtras } from './useAgentModelExtras'

interface Props {
  providers: ProviderRecord[]
  providerId: string
  model: string
  extras: AgentModelExtras
  /** 文本协议徽标：Agent 壳把它放在「+」菜单里，所以那边传 false（避免同一开关出现两颗） */
  showTextProtocol?: boolean
}

export const ModelExtrasBadges: React.FC<Props> = ({
  providers,
  providerId,
  model,
  extras,
  showTextProtocol = true
}) => {
  const { t } = useI18n()
  // §234 的小编辑器：打开时把当前值灌进草稿（不打开就不建这个 state 的内容）
  const [windowOpen, setWindowOpen] = useState(false)
  const [windowDraft, setWindowDraft] = useState('')
  const draftNumber = windowDraft.trim() === '' ? Number.NaN : Number(windowDraft)
  const draftValid = Number.isInteger(draftNumber)
  // §237 的备用编辑器：草稿是一对 provider＋模型，两个都选了才能保存
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [fallbackDraftProvider, setFallbackDraftProvider] = useState('')
  const [fallbackDraftModel, setFallbackDraftModel] = useState('')
  const { contextWindowTokens, contextWindowUnread, setContextWindow, fallbackTarget, fallbackMissing, fallbackUnread, setFallback } =
    extras
  /** 能当备用的候选：排除当前这台自己（换成自己＝一次没换的"换"，比没有更误导） */
  const fallbackOptions = providers
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models.filter((m) => !(p.id === providerId && m === model))
    }))
    .filter((p) => p.models.length > 0)
  const draftFallbackValid = !!fallbackDraftProvider && !!fallbackDraftModel
  const fallbackProviderName = fallbackTarget
    ? providers.find((p) => p.id === fallbackTarget.providerId)?.name ?? fallbackTarget.providerId
    : ''

  return (
    <>
      {/* 模型级「上下文窗口」输入（§234）。未设过的模型仍走原来的 30 条，所以这里没设就直说没设 */}
      {providerId && model && (
        <button
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            contextWindowTokens != null
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
          }`}
          title={contextWindowUnread ? `${t('agent.windowUnread')} — ${contextWindowUnread}` : t('agent.windowHint')}
          data-testid="agent-window-badge"
          onClick={() => {
            setWindowDraft(contextWindowTokens == null ? '' : String(contextWindowTokens))
            setWindowOpen((v) => !v)
          }}
        >
          {contextWindowUnread
            ? t('agent.windowReadFail')
            : contextWindowTokens == null
              ? t('agent.windowUnset')
              : t('agent.windowValue', { n: contextWindowTokens })}
        </button>
      )}
      {windowOpen && (
        <div
          className="basis-full flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-2 py-1.5"
          data-testid="agent-window-editor"
        >
          <input
            type="number"
            className="select-mini w-[130px]"
            aria-label={t('agent.window')}
            min={MODEL_WINDOW_MIN_TOKENS}
            max={MODEL_WINDOW_MAX_TOKENS}
            step={1024}
            placeholder={`${MODEL_WINDOW_MIN_TOKENS}–${MODEL_WINDOW_MAX_TOKENS}`}
            value={windowDraft}
            onChange={(e) => setWindowDraft(e.target.value)}
          />
          {/* 草稿不是整数就不让保存：这一脸不发垃圾去主进程，也不假装"已保存" */}
          <button
            className="btn-ghost text-xs shrink-0"
            disabled={!draftValid}
            onClick={() => {
              if (!draftValid) return
              setContextWindow(draftNumber)
              setWindowOpen(false)
            }}
          >
            {t('common.save')}
          </button>
          <button
            className="btn-ghost text-xs shrink-0"
            onClick={() => {
              setContextWindow(null)
              setWindowOpen(false)
            }}
          >
            {t('agent.windowClear')}
          </button>
          <span className="text-[10px] text-[var(--color-text-muted)] leading-snug">
            {t('agent.windowEditorTip', {
              default: DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
              min: MODEL_WINDOW_MIN_TOKENS,
              max: MODEL_WINDOW_MAX_TOKENS
            })}
          </span>
          <span className="basis-full text-[10px] text-[var(--color-text-muted)] leading-snug">
            {t('agent.windowNotNumCtx')}
          </span>
        </div>
      )}

      {/* 模型级「备用 target」（§237）：同一台重试耗尽后允许换的那一台。徽标有四张脸，逐张说实话 */}
      {providerId && model && (
        <button
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            fallbackTarget && !fallbackMissing
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
          }`}
          title={fallbackUnread ? `${t('agent.fallbackUnread')} — ${fallbackUnread}` : t('agent.fallbackHint')}
          data-testid="agent-fallback-badge"
          onClick={() => {
            setFallbackDraftProvider(
              fallbackTarget && providers.some((p) => p.id === fallbackTarget.providerId)
                ? fallbackTarget.providerId
                : ''
            )
            setFallbackDraftModel(fallbackTarget?.model ?? '')
            setFallbackOpen((v) => !v)
          }}
        >
          {fallbackUnread
            ? t('agent.fallbackReadFail')
            : !fallbackTarget
              ? t('agent.fallbackUnset')
              : fallbackMissing
                ? t('agent.fallbackMissing', { model: fallbackTarget.model })
                : t('agent.fallbackValue', { name: fallbackProviderName, model: fallbackTarget.model })}
        </button>
      )}
      {fallbackOpen && (
        <div
          className="basis-full flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-2 py-1.5"
          data-testid="agent-fallback-editor"
        >
          <span className="text-[10px] font-semibold text-[var(--color-text-muted)] shrink-0">{t('agent.fallback')}</span>
          <select
            className="select-mini w-[150px]"
            aria-label={t('agent.fallbackProvider')}
            value={fallbackDraftProvider}
            onChange={(e) => {
              setFallbackDraftProvider(e.target.value)
              setFallbackDraftModel('')
            }}
          >
            <option value="">{t('agent.selectProvider')}</option>
            {fallbackOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            className="select-mini w-[170px]"
            aria-label={t('agent.fallbackModel')}
            value={fallbackDraftModel}
            disabled={!fallbackDraftProvider}
            onChange={(e) => setFallbackDraftModel(e.target.value)}
          >
            <option value="">{t('agent.selectModel')}</option>
            {(fallbackOptions.find((p) => p.id === fallbackDraftProvider)?.models ?? []).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {/* 两个都没选就不让保存：宁可让按钮灰着，也不要发一次"清除"或一条空备用出去 */}
          <button
            className="btn-ghost text-xs shrink-0"
            disabled={!draftFallbackValid}
            data-testid="agent-fallback-save"
            onClick={() => {
              if (!draftFallbackValid) return
              setFallback({ providerId: fallbackDraftProvider, model: fallbackDraftModel })
              setFallbackOpen(false)
            }}
          >
            {t('common.save')}
          </button>
          <button
            className="btn-ghost text-xs shrink-0"
            data-testid="agent-fallback-clear"
            onClick={() => {
              setFallback(null)
              setFallbackOpen(false)
            }}
          >
            {t('agent.fallbackClear')}
          </button>
          <span className="basis-full text-[10px] text-[var(--color-text-muted)] leading-snug">{t('agent.fallbackEditorTip')}</span>
        </div>
      )}

      {/* 文本协议徽标：三态脸（读不到 / 已点名 / 未点名）。读不到时点击＝重读那次清单，不再演成"关着" */}
      {showTextProtocol && providerId && model && (
        <button
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            extras.textProtocolUnread
              ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
              : extras.textProtocolForced
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
          }`}
          title={
            extras.textProtocolUnread
              ? `${t('agent.textProtocolUnread')} — ${extras.textProtocolUnread}`
              : extras.textProtocolForced
                ? t('agent.textProtocolOnHint')
                : t('agent.textProtocolHint')
          }
          data-testid="chat-text-protocol-badge"
          onClick={() => {
            if (extras.textProtocolUnread) extras.retryTextProtocol()
            else extras.setTextProtocol(!extras.textProtocolForced)
          }}
        >
          {extras.textProtocolUnread
            ? t('agent.textProtocolReadFail')
            : extras.textProtocolForced
              ? t('agent.textProtocolOn')
              : t('agent.textProtocol')}
        </button>
      )}
    </>
  )
}
