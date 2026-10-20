// Agent 模型配置栏：Provider / 模型选择 + 模型列表拉取 + 工作目录
import React, { useState } from 'react'
import type { ProviderRecord } from '../../../../../shared/types'
import {
  DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS
} from '../../../../../shared/model-window'
import { useI18n } from '../../../i18n'

interface Props {
  providers: ProviderRecord[]
  providerId: string
  model: string
  onProviderChange: (id: string) => void
  onModelChange: (model: string) => void
  selectedProvider?: ProviderRecord
  fetchingModels: boolean
  onFetchModels: () => void
  workspaceDir: string
  onPickWorkspace: () => void
  /** 当前 provider+model 是否被点名走文本协议（§4.4-⑦ 显式开关） */
  textProtocolForced?: boolean
  /** 开/关当前这台模型的文本协议；不传则不出现开关（如未选模型） */
  onToggleTextProtocol?: (on: boolean) => void
  /** §234：这台模型声明的上下文窗口（token）；null/undefined=未设，引擎按最近的 30 条走 */
  contextWindowTokens?: number | null
  /** 那一读失败过的原因；非空时按钮不许演成"未设"，要说是读不到 */
  contextWindowUnread?: string | null
  /** 设/清当前模型的窗口（null=清除）；不传则不出现这个控件 */
  onSetContextWindow?: (tokens: number | null) => void
}

export const AgentModelBar: React.FC<Props> = ({
  providers,
  providerId,
  model,
  onProviderChange,
  onModelChange,
  selectedProvider,
  fetchingModels,
  onFetchModels,
  workspaceDir,
  onPickWorkspace,
  textProtocolForced,
  onToggleTextProtocol,
  contextWindowTokens,
  contextWindowUnread,
  onSetContextWindow
}) => {
  const { t } = useI18n()
  // §234 的小编辑器：打开时把当前值灌进草稿（不打开就不建这个 state 的内容）
  const [windowOpen, setWindowOpen] = useState(false)
  const [windowDraft, setWindowDraft] = useState('')
  const draftNumber = windowDraft.trim() === '' ? Number.NaN : Number(windowDraft)
  const draftValid = Number.isInteger(draftNumber)
  return (
    <div className="flex items-center gap-2 flex-wrap mb-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-2 py-1">
      <span className="text-xs font-semibold text-[var(--color-text-muted)] shrink-0">
        {t('agent.modelConfig')}
      </span>
      {/* min-w 不是装饰：这一栏里徽标与工作目录都是 shrink-0，窗口一窄，
          两个 flex-1 的下拉会被压到 0 宽（选中值完全看不见）。宁可换行，不许塌陷。 */}
      <select
        className="select-mini flex-1 min-w-[120px]"
        value={providerId}
        onChange={(e) => onProviderChange(e.target.value)}
      >
        <option value="">{t('agent.selectProvider')}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {selectedProvider && selectedProvider.models.length > 0 ? (
        <select
          className="select-mini flex-1 min-w-[120px]"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
        >
          <option value="">{t('agent.selectModel')}</option>
          {selectedProvider.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      ) : selectedProvider ? (
        <>
          <span className="text-xs text-[var(--color-text-muted)] flex-1 min-w-[120px] truncate">
            {t('agent.noModelsHint')}
          </span>
          <button
            className="btn-ghost text-xs shrink-0"
            disabled={fetchingModels}
            onClick={onFetchModels}
          >
            {fetchingModels ? t('agent.fetching') : t('agent.fetchModels')}
          </button>
        </>
      ) : null}
      {/* 模型级「走文本协议」开关：常驻可见（关闭入口不能只藏在零调用提示里，
          否则协议生效后模型开始调工具，那条提示就再也不出现、开关也就关不掉了） */}
      {onToggleTextProtocol && providerId && model && (
        <button
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            textProtocolForced
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
          }`}
          title={textProtocolForced ? t('agent.textProtocolOnHint') : t('agent.textProtocolHint')}
          onClick={() => onToggleTextProtocol(!textProtocolForced)}
        >
          {textProtocolForced ? t('agent.textProtocolOn') : t('agent.textProtocol')}
        </button>
      )}
      {/* 模型级「上下文窗口」输入（§234）。未设过的模型仍走原来的 30 条，所以这里没设就直说没设，
          不给一个看起来像"当前值"的数——那是把默认值冒充读数（§226 那一族的反面）。 */}
      {onSetContextWindow && providerId && model && (
        <button
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            contextWindowTokens != null
              ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]'
          }`}
          title={
            contextWindowUnread
              ? `${t('agent.windowUnread')} — ${contextWindowUnread}`
              : t('agent.windowHint')
          }
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
      {windowOpen && onSetContextWindow && (
        <div className="basis-full flex flex-wrap items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-2 py-1.5">
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
              onSetContextWindow(draftNumber)
              setWindowOpen(false)
            }}
          >
            {t('common.save')}
          </button>
          <button
            className="btn-ghost text-xs shrink-0"
            onClick={() => {
              onSetContextWindow(null)
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
      <button
        className="btn-ghost text-xs shrink-0 max-w-[180px]"
        onClick={onPickWorkspace}
        title={workspaceDir || t('agent.workspacePickTip')}
      >
        <span className="block truncate">
          📁 {workspaceDir
            ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() || workspaceDir
            : t('agent.workspaceNone')}
        </span>
      </button>
    </div>
  )
}
