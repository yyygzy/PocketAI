// 数据健康里「Agent 分步明细」那一行的文案。
// 抽成纯函数供用例钉住两件事：空态必须复用 agent 面板已有的那句（不另造词），
// 以及那两个数各自的位置（总行数在前、单会话最多在后——后者才是复合索引的自变量）。
import type { DataHealthReport } from '../../../shared/types'

type TFn = (key: string, vars?: Record<string, string | number>) => string

export function formatTraceLedger(traces: DataHealthReport['traces'], t: TFn): string {
  if (traces.rows <= 0) return t('agent.traceEmpty')
  return t('dh.traces.value', {
    rows: traces.rows.toLocaleString('en-US'),
    max: traces.maxRowsInOneConversation.toLocaleString('en-US')
  })
}
