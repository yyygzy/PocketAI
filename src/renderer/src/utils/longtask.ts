// 渲染层长任务观测：PerformanceObserver('longtask') 捕获 ≥50ms 的主线程阻塞，
// 超过阈值（200ms）的经 reportPerf 上报主进程环形缓冲（数据健康面板「最近慢操作」可见）。
// 用途：实测定位「入库/检索时界面是否真卡」——若卡顿存在应能在此捕获长任务。
// 不支持 longtask 的环境（旧 Chromium）静默跳过；5s 节流防止卡顿风暴灌爆缓冲。
import { reportIpcError } from './ipc'

const REPORT_THRESHOLD_MS = 200
const THROTTLE_MS = 5_000

let started = false
let lastReportAt = 0

/** 启动长任务观测（幂等，重复调用无副作用） */
export function startLongTaskObserver(): void {
  if (started) return
  if (typeof PerformanceObserver === 'undefined') return
  let observer: PerformanceObserver
  try {
    observer = new PerformanceObserver((list) => {
      const now = Date.now()
      for (const entry of list.getEntries()) {
        if (entry.duration < REPORT_THRESHOLD_MS) continue
        if (now - lastReportAt < THROTTLE_MS) continue
        lastReportAt = now
        window.pocketai
          .reportPerf('renderer:longtask', Math.round(entry.duration))
          .catch(reportIpcError('reportPerf'))
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // 该环境不支持 longtask 类型：静默跳过
    return
  }
  started = true
}
