import { useI18n } from '../../i18n'
import { delegateRoleLabel, type LiveStep } from './agent-shared'

interface AgentLiveStepStripProps {
  /** 由 `reduceLiveSteps` 归约的 chip 流（与 Agent 调试台同源，不另起解析） */
  steps: LiveStep[]
  /** 当前步号；缺省取最后一颗 chip 的 stepIndex */
  currentStep?: number
  /** 结束后收起：false 时不渲染 */
  running?: boolean
  /** 深度联网检索进行中（由 `judgeDeepSearchRunning` 判定后传入） */
  deepSearchRunning?: boolean
  className?: string
}

/**
 * P2 / V4-Iter-459：运行中实时步骤条（chip 流）。
 *
 * 从 Agent 调试台原样抽出，两处共用同一份渲染：调试台输入区上方、对话页的实时 Agent 卡片。
 * 零步骤（还没收到任何 step 事件）或已结束时返回 null——不留一条空的运行中占位。
 */
export function AgentLiveStepStrip({
  steps,
  currentStep,
  running = true,
  deepSearchRunning = false,
  className = ''
}: AgentLiveStepStripProps) {
  const { t } = useI18n()
  if (!running || steps.length === 0) return null
  const stepNo = currentStep ?? steps[steps.length - 1]!.stepIndex

  return (
    <div
      data-testid="agent-live-step-strip"
      className={`flex items-center gap-2 text-xs text-[var(--color-text-muted)] ${className}`}
    >
      <span className="inline-block w-2 h-2 shrink-0 rounded-full bg-[var(--color-accent)] animate-pulse" />
      <span className="shrink-0">{t('agent.runningStep', { n: stepNo })}</span>
      {deepSearchRunning && (
        <span className="shrink-0 text-[var(--color-accent)]">{t('agent.websearch.deepRunning')}</span>
      )}
      <div className="flex-1 min-w-0 overflow-x-auto flex items-center gap-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {steps.map((s, i) => {
          const isLast = i === steps.length - 1
          return (
            <span
              key={`${s.stepIndex}-${s.type}-${i}`}
              data-testid={`agent-live-step-${i}`}
              className={`shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] leading-none ${
                s.type === 'error'
                  ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
              } ${isLast ? 'animate-pulse border-[var(--color-accent)] text-[var(--color-accent)]' : ''}`}
            >
              <span>{t(`agent.liveStep.${s.type}`)}</span>
              {/* 委派那一步用角色标签替掉裸工具名：delegate_task 对用户不如"派了谁"有用 */}
              {s.role ? (
                <span className="text-[var(--color-accent)]" data-delegate-role={s.role}>
                  {delegateRoleLabel(t, s.role)}
                </span>
              ) : (
                s.toolName && <span className="text-[var(--color-accent)]">{s.toolName}</span>
              )}
              <span className="opacity-60">#{s.stepIndex}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
