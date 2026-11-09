// Agent 模型配置栏：Provider / 模型选择 + 模型列表拉取 + 这台模型的窗口/备用
// §399②a：「走文本协议」与 📁 工作目录两颗徽标搬进了输入框那颗「+」——它们是"这一轮怎么跑"的设置，
// 不是"这台模型"的属性；这里只留 provider／model 两颗下拉与上下文窗口／备用 target 两颗徽标。
import React from 'react'
import type { ProviderRecord } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import type { FallbackTarget } from '../../../../../shared/fallback-target'
import { ModelExtrasBadges } from '../../chat/ModelExtrasBadges'

interface Props {
  providers: ProviderRecord[]
  providerId: string
  model: string
  onProviderChange: (id: string) => void
  onModelChange: (model: string) => void
  selectedProvider?: ProviderRecord
  fetchingModels: boolean
  onFetchModels: () => void
  /** §234：这台模型声明的上下文窗口（token）；null/undefined=未设，引擎按最近的 30 条走 */
  contextWindowTokens?: number | null
  /** 那一读失败过的原因；非空时按钮不许演成"未设"，要说是读不到 */
  contextWindowUnread?: string | null
  /** 设/清当前模型的窗口（null=清除）；不传则不出现这个控件 */
  onSetContextWindow?: (tokens: number | null) => void
  /**
   * §237：这台模型的备用 target。三种"没有"要分开说：没设过／读不到／设了但那台已经不在这个实例里
   * （provider 被删或停用、模型清单漂移）——把第三种演成第一种，用户会以为"没兜底"，其实是"兜底指向了一个不存在的"。
   */
  fallbackTarget?: FallbackTarget | null
  fallbackMissing?: boolean
  fallbackUnread?: string | null
  /** 设/清当前模型的备用（null=清除）；不传则不出现这个控件 */
  onSetFallback?: (target: FallbackTarget | null) => void
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
  contextWindowTokens,
  contextWindowUnread,
  onSetContextWindow,
  fallbackTarget,
  fallbackMissing,
  fallbackUnread,
  onSetFallback
}) => {
  const { t } = useI18n()
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
      {/* 窗口 / 备用 / 文本协议徽标：展示实现已抽到 `ModelExtrasBadges`（P4 批次 0，与对话壳共用）。
          Agent 壳仍把「走文本协议」开关放在「+」菜单里，故这里 showTextProtocol=false。 */}
      <ModelExtrasBadges
        providers={providers}
        providerId={providerId}
        model={model}
        showTextProtocol={false}
        extras={{
          textProtocolForced: false,
          textProtocolUnread: null,
          retryTextProtocol: () => { /* 旧壳的清单重读在「+」菜单旁 */ },
          setTextProtocol: () => { /* 旧壳的开关在「+」菜单里 */ },
          contextWindowTokens: contextWindowTokens ?? null,
          contextWindowUnread: contextWindowUnread ?? null,
          setContextWindow: (n) => onSetContextWindow?.(n),
          fallbackTarget: fallbackTarget ?? null,
          fallbackMissing: fallbackMissing ?? false,
          fallbackUnread: fallbackUnread ?? null,
          setFallback: (f) => onSetFallback?.(f)
        }}
      />
    </div>
  )
}
