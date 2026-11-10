// 启动性能埋点：bootMark 记录各阶段相对 boot 起点的累计耗时，并写 [perf] 日志。
// 计时起点 = 本模块加载时刻（index.ts 入口 import 本模块，早于其模块体执行，
// 比 process ready 后再取起点更贴近真实冷启动）。
import { createLogger } from '../logger'

const log = createLogger('boot')

const BOOT_T0 = performance.now()

/**
 * 记录一个启动阶段的到达时刻。
 * @param label 日志可读名（写 [perf] 日志）
 */
export function bootMark(label: string): void {
  const ms = Math.round(performance.now() - BOOT_T0)
  log.info(`[perf] ${label}: ${ms}ms`)
}
