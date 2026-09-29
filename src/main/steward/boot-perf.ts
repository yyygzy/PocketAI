// 启动性能埋点：bootMark 记录各阶段相对 boot 起点的累计耗时（内存 + [perf] 日志），
// 供数据健康面板读取展示（USB 冷启动优化效果可视化）。
// 独立模块原因：data-health 需读取埋点数据，直接 import index.ts 会形成循环依赖。
import { createLogger } from '../logger'

const log = createLogger('boot')

export type BootStageId =
  | 'dirs'
  | 'db'
  | 'unlock'
  | 'window'
  | 'credentials'
  | 'assistants'
  | 'popup'
  | 'schedulers'

export interface BootStageMark {
  id: BootStageId
  /** 相对 boot 起点的累计毫秒 */
  ms: number
}

// 计时起点 = 本模块加载时刻（index.ts 入口 import 本模块，早于其模块体执行，
// 比 process ready 后再取起点更贴近真实冷启动）
const BOOT_T0 = performance.now()
const stages: BootStageMark[] = []

/**
 * 记录一个启动阶段的到达时刻。
 * @param id    稳定阶段标识（渲染层 i18n 映射用）
 * @param label 日志可读名（写 [perf] 日志）
 */
export function bootMark(id: BootStageId, label: string): void {
  const ms = Math.round(performance.now() - BOOT_T0)
  stages.push({ id, ms })
  log.info(`[perf] ${label}: ${ms}ms`)
}

/** 本次启动各阶段耗时快照（只读副本：数组与元素均拷贝，外部修改不影响内部状态） */
export function getBootPerf(): { stages: BootStageMark[]; totalMs: number } {
  return {
    stages: stages.map((s) => ({ ...s })),
    totalMs: stages.length > 0 ? stages[stages.length - 1]!.ms : 0
  }
}
