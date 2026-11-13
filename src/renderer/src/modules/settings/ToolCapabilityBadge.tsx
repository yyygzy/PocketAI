// 工具调用能力徽标（P0-4b）——"这台模型会不会调工具"，把四档判定摆在模型旁边
//
// 与委派徽标分开成两个组件：两个结论各存各的键，措辞也不一样。
// 四条措辞纪律：
//  · 未检测 ≠ 不会：没测出来/网络失败/跳过都只说"未检测"，并给原因；
//  · 已知不可用也不许说"模型坏了"：围栏格式与端点拒绝各有各的原因句；
//  · 可能不可用要带上计数据（"2/3"），不凭一句话下结论；
//  · 探测要花用户的钱：按钮的 title 与设置页那行提示都必须写明"3 次请求，计入你的额度"。
import React from 'react'
import type { ToolCapabilityView } from '../../../../shared/tool-capability'
import { toolReasonText, toolTierText } from '../../../../shared/tool-capability'
import { useI18n } from '../../i18n'

const TONE = {
  usable: 'text-[var(--color-success,#2e7d32)]',
  likely_unusable: 'text-[var(--color-warning,#b26a00)]',
  known_unusable: 'text-[var(--color-danger)]',
  unknown: 'text-[var(--color-text-muted)]'
} as const

export const ToolCapabilityBadge: React.FC<{
  /** 该模型已有的判定；null/undefined = 没测过 */
  entry: ToolCapabilityView | null | undefined
  /** 这台正在探测中（按钮要禁用，避免连点打满本地模型/重复计费） */
  probing: boolean
  onProbe: () => void
  onStopProbe: () => void
}> = ({ entry, probing, onProbe, onStopProbe }) => {
  const { t } = useI18n()
  const tier = entry?.tier ?? 'unknown'
  const reason = entry ? toolReasonText(t, entry) : ''
  // 只有真正判过且拿到样本时才摆分数；unknown / 端点拒绝（samples=0）都不摆
  const showHits = !!entry && entry.samples > 0 && entry.tier !== 'unknown'
  const title = [t('provider.toolCapHint'), reason].filter(Boolean).join('｜')

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {entry && (
        <span data-tool-capability={entry.tier} title={title} className={`text-[10px] ${TONE[tier]}`}>
          {toolTierText(t, tier)}
          {showHits && (
            <span className="opacity-70">
              {' '}
              {entry.nativeHits}/{entry.samples}
            </span>
          )}
          {entry.stale && <span className="opacity-80"> {t('provider.toolCapStale')}</span>}
        </span>
      )}
      <button
        type="button"
        disabled={probing}
        onClick={onProbe}
        title={`${title}｜${t('provider.toolCapFee')}`}
        className="text-[10px] px-1 py-0.5 rounded border border-[var(--color-border)] opacity-70 hover:opacity-100 disabled:opacity-40 leading-none"
      >
        {probing ? t('provider.toolCapProbing') : t('provider.toolCapProbe')}
      </button>
      {probing && (
        <button
          type="button"
          data-testid="tool-cap-stop"
          onClick={onStopProbe}
          title={t('provider.toolCapStopHint')}
          className="text-[10px] px-1 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:opacity-80 leading-none"
        >
          {t('provider.toolCapStop')}
        </button>
      )}
    </span>
  )
}
