// 委派能力徽标（V4-Iter-142）——"这台模型当得了中心管控者吗"，把探针结论摆在模型旁边
//
// 单独成组件的原因与 `ZeroToolCallNotice` / 检索降级徽标同一条：ProviderSettings 挂着 confirm /
// toast / 一堆 IPC，在 jsdom 里整块挂成本高；判定与呈现抽出来后，三态文案能被逐字断言。
//
// 一条措辞纪律（决策①的结论）：**fence_only 不是"能用"**。模型自发写 ```json 围栏而引擎只认
// ```tool_call，实测放宽解析也只到 50% —— 所以这一态的话必须直说"当前用不了"，不许写成"勉强可用"。
import React from 'react'
import type { DelegateCapability, DelegateCapabilityView, DelegateFailure } from '../../../../shared/delegate-capability'
import { delegateFailureText } from '../../../../shared/delegate-capability'
import { useI18n } from '../../i18n'

/** 三态文案键：设置页探测完也要用同一份，别两处各写一句话 */
export const DELEGATE_CAPABILITY_LABEL_KEY = {
  native_tools_ok: 'provider.capNative',
  fence_only: 'provider.capFence',
  no_delegation: 'provider.capNone',
  unknown: 'provider.capUnknown'
} as const

/**
 * 把"委派这一路回给界面的失败"翻成当前界面的那句话（V4-Iter-152）。
 * 两条来源要分开，不许混着显示：
 *  · **业务拒绝**（拒探 / 开启委派被挡 / 探测没跑完）= 一个码 + 几个数 ⇒ 走话术表；
 *  · **IPC 层拒绝**（`safeHandle` 的参数校验、抛出的异常）= 技术性字符串 ⇒ 照原样给（与 `ipcFailText` 同一口径），
 *    把它翻译成四语反而是把 zod 的报错话术变成第二份 UI 文案。
 * `params.capability` 再走一次标签映射：`fence_only` 这类是**内部枚举值**，直接插进句子等于让用户读标识符。
 */
export function delegateNoticeText(
  t: (key: string, params?: Record<string, string | number>) => string,
  error: DelegateFailure | string | null | undefined,
  fallback: string
): string {
  if (error === null || error === undefined) return fallback
  if (typeof error === 'string') return error || fallback
  const params: Record<string, string | number> = { ...(error.params ?? {}) }
  const cap = params.capability
  if (typeof cap === 'string' && cap in DELEGATE_CAPABILITY_LABEL_KEY) {
    params.capability = t(DELEGATE_CAPABILITY_LABEL_KEY[cap as DelegateCapability])
  }
  return delegateFailureText(t, { ...error, params }, fallback)
}

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
  /** §246：探测中那颗「停止探针」按下去走这里（主进程那一发被中止，返回码 `probe_aborted`） */
  onStopProbe: () => void
  /** 决策③：开/关这台模型的顺序委派（默认关） */
  onToggleDelegation: (on: boolean) => void
}> = ({ entry, probing, onProbe, onStopProbe, onToggleDelegation }) => {
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
            // disabled 交给浏览器拦是不可靠的（jsdom 里点击照样进 onChange），而这条勾下去就是
            // 一次真授权：所以点不动的那种情况在组件里也**直接 return**（主进程还会再判一次前置条件）。
            onChange={(e) => {
              if (!canEnable) return
              onToggleDelegation(e.target.checked)
            }}
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
      {/* §246：那一发可能永远不回来 ⇒ 探测中给一条退路。放在同一格里，不另起一行（这排本来就是徽标＋两颗小键） */}
      {probing && (
        <button
          type="button"
          data-testid="probe-stop"
          onClick={onStopProbe}
          title={t('provider.stopProbeHint')}
          className="text-[10px] px-1 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:opacity-80 leading-none"
        >
          {t('provider.stopProbe')}
        </button>
      )}
    </span>
  )
}
