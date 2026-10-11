// Agent 分步明细的 token 文案（从 AgentPanel 抽出来，好让用例能钉住降级规则）
//
// 口径：
// - 有拆分 → 「输入 X / 输出 Y tokens」。输入是本步重发的全部上下文，
//   一次任务花掉上万 token 时，只有拆开才看得出贵在哪一步、贵在上文还是模型话多。
// - 没拆分但有合计（v46 迁移前的旧行、或端点不上报 usage）→ 退回「N tokens」。
// - 两个都没有（工具步不发请求）→ 不占位。
import type { AgentTraceRecord } from '../../../shared/types'

type TFn = (key: string, vars?: Record<string, string | number>) => string

const num = (n: number): string => n.toLocaleString('en-US')

export function formatStepTokens(tr: AgentTraceRecord, t: TFn): string | null {
  if (typeof tr.promptTokens === 'number' && typeof tr.completionTokens === 'number') {
    return t('agent.stepTokens', { in: num(tr.promptTokens), out: num(tr.completionTokens) })
  }
  if (typeof tr.tokenUsage === 'number') return `${num(tr.tokenUsage)} tokens`
  return null
}
