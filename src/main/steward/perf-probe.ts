// 运行期慢操作埋点（与 boot-perf 互补：boot 管启动，本模块管运行期）
// recordPerf 记录一条事件：写 [perf] 日志 + 入内存环形缓冲（上限 100，FIFO 淘汰）。
// 数据健康面板通过 getRecentPerf 快照展示「最近慢操作」，供实测定位卡顿根因。
import { createLogger } from '../logger'
import type { PerfEvent } from '../../shared/types'

const log = createLogger('perf')

const MAX_EVENTS = 100
const events: PerfEvent[] = []

/**
 * 记录一次运行期耗时事件。
 * 调用方自行把控阈值（低于阈值不进缓冲）；日志无条件记录（info 级）。
 */
export function recordPerf(label: string, ms: number, detail?: string): void {
  const evt: PerfEvent = { label, ms: Math.round(ms), detail, at: Date.now() }
  events.push(evt)
  if (events.length > MAX_EVENTS) events.shift()
  log.info(`[perf] ${label}: ${evt.ms}ms${detail ? ` | ${detail}` : ''}`)
}

/** 最近慢操作快照（只读副本：数组与元素均拷贝，外部修改不影响内部状态） */
export function getRecentPerf(): PerfEvent[] {
  return events.map((e) => ({ ...e }))
}

/** 低于阈值事件的调试日志（不入缓冲，避免缓冲被快操作稀释） */
export function logPerfDebug(label: string, ms: number, detail?: string): void {
  log.debug(`[perf] ${label}: ${Math.round(ms)}ms${detail ? ` | ${detail}` : ''}`)
}

/** 测试用：清空缓冲 */
export function clearPerfEvents(): void {
  events.length = 0
}
