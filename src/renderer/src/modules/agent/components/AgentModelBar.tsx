// Agent 模型配置栏：Provider / 模型选择 + 模型列表拉取 + 工作目录
import React from 'react'
import type { ProviderRecord } from '../../../../../shared/types'
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
  onPickWorkspace
}) => {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
      <span className="text-xs font-semibold text-[var(--color-text-muted)] shrink-0">
        {t('agent.modelConfig')}
      </span>
      <select
        className="select-mini flex-1 min-w-0"
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
          className="select-mini flex-1 min-w-0"
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
          <span className="text-xs text-[var(--color-text-muted)] flex-1 min-w-0 truncate">
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
