// 跨会话慢事件统计：从已落盘的日志尾部聚合，不新增任何持久化格式
//
// 内存环形缓冲（perf-probe）只有本次会话的 100 条，面板一重启就清零，
// 而慢事件本来就无条件 info 落盘，所以跨会话视图直接读日志尾部即可。
// 只把聚合结果过 IPC（日志原文可能含用户数据，见 SEC-14 的脱敏口径）。
import { readLogTail } from '../logger'
import { parsePerfLine, summarizePerf } from '../../shared/perf-lines'
import type { PerfSummary } from '../../shared/types'

/** 面板可展示的标签行上限（超出部分仍在日志里，肉眼可查） */
const MAX_ROWS = 8

/** 读日志尾部 [perf] 慢事件并按标签聚合（日志缺失/不可读时返回空数组） */
export function getPerfHistory(): PerfSummary[] {
  try {
    const events = readLogTail()
      .map(parsePerfLine)
      .filter((e): e is NonNullable<typeof e> => e !== null)
    return summarizePerf(events, MAX_ROWS)
  } catch {
    return []
  }
}
