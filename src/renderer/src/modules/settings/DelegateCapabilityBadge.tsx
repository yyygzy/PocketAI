// 委派能力徽标（V4-Iter-142）——"这台模型当得了中心管控者吗"，把探针结论摆在模型旁边
//
// 单独成组件的原因与 `ZeroToolCallNotice` / 检索降级徽标同一条：ProviderSettings 挂着 confirm /
// toast / 一堆 IPC，在 jsdom 里整块挂成本高；判定与呈现抽出来后，三态文案能被逐字断言。
//
// 一条措辞纪律（决策①的结论）：**fence_only 不是"能用"**。模型自发写 ```json 围栏而引擎只认
// ```tool_call，实测放宽解析也只到 50% —— 所以这一态的话必须直说"当前用不了"，不许写成"勉强可用"。
import React from 'react'
import type { DelegateCapabilityView } from '../../../../shared/delegate-capability'
import { useI18n } from '../../i18n'

/** 三态文案键：设置页探测完也要用同一份，别两处各写一句话 */
export const DELEGATE_CAPABILITY_LABEL_KEY = {
  native_tools_ok: 'provider.capNative',
  fence_only: 'provider.capFence',
  no_delegation: 'provider.capNone',
  unknown: 'provider.capUnknown'
} as const

const TONE = {
  native_tools_ok: 'text-[var(--color-success,#2e7d32)]',
  fence_only: 'text-[var(--color-warning,#b26a00)]',
  no_delegation: 'text-[var(--color-danger)]',
  unknown: 'text-[var(--color-text-muted)]'
} as const

export const DelegateCapabilityBadge: React.FC<{
  /** 该模型已有的判定；null/undefined = 没探过 */
  entry: DelegateCapabilityView | null | undefined
  /** 这台正在探测中（按钮要禁用，避免连点打满本地模型） */
  probing: boolean
  onProbe: () => void
  /** 决策③：开/关这台模型的顺序委派（默认关） */
  onToggleDelegation: (on: boolean) => void
}> = ({ entry, probing, onProbe, onToggleDelegation }) => {
  const { t } = useI18n()
  const cap = entry?.capability ?? 'unknown'
  const hasVerdict = !!entry && entry.capability !== 'unknown'
  // 只有"判定是可当管控者且未过期"才允许开（与主进程 setDelegationEnabled 的前置条件同源）
  const canEnable = !!entry && entry.capability === 'native_tools_ok' && !entry.stale
  const blockedReason = !entry
    ? t('provider.capDelegationNeedsProbe')
    : entry.stale
      ? t('provider.capDelegationStale')
      : t('provider.capDelegationNeedsProbe')

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {entry && (
        <label
          className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
          title={canEnable ? t('provider.capDelegationHint') : blockedReason}
        >
          <input
            type="checkbox"
            checked={!!entry.delegationEnabled}
            disabled={!canEnable}
            onChange={(e) => onToggleDelegation(e.target.checked)}
          />
          {t('provider.capAllowDelegation')}
        </label>
      )}
      {entry && (
        <span
          data-capability={entry.capability}
          title={`${t('provider.capHint')}${entry.capability === 'unknown' ? `（${t('provider.capUnknownReason')}）` : ''}`}
          className={`text-[10px] ${TONE[cap]}`}
        >
          {t(DELEGATE_CAPABILITY_LABEL_KEY[cap])}
          {hasVerdict && (
            <span className="opacity-70">
              {' '}
              {entry.nativeHits}/{entry.samples}
            </span>
          )}
          {entry.stale && <span className="opacity-80"> {t('provider.capStale')}</span>}
        </span>
      )}
      <button
        type="button"
        disabled={probing}
        onClick={onProbe}
        title={t('provider.capHint')}
        className="text-[10px] px-1 py-0.5 rounded border border-[var(--color-border)] opacity-70 hover:opacity-100 disabled:opacity-40 leading-none"
      >
        {probing ? t('provider.capProbing') : t('provider.capProbe')}
      </button>
    </span>
  )
}
