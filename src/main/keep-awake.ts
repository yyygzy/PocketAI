// 后台保活（锁屏/后台任务不中断）
//
// 两个层次：
// 1. 渲染层防节流（main/index.ts 启动参数 + setBackgroundThrottling）：
//    窗口最小化/被遮挡时 Chromium 默认把 renderer 定时器降到 1Hz、降线程优先级，
//    导致后台生成/流式 UI 卡顿——启动即禁用，应用整个生命周期生效。
// 2. 任务级保活（本文件，powerSaveBlocker 引用计数）：
//    流式生成 / 更新下载进行中调用 acquireKeepAwake() 阻止系统睡眠挂起，
//    结束（成功/失败/中止）后 releaseKeepAwake() 放行；支持并发任务叠加。
//    系统因此不会在任务中途睡眠，配合锁屏（锁屏≠睡眠）实现「锁屏后台任务继续」。
import { powerSaveBlocker } from 'electron'

let blockerId: number | null = null
let refCount = 0

/** 任务开始：阻止系统睡眠挂起（可重入，引用计数） */
export function acquireKeepAwake(): void {
  refCount++
  if (blockerId === null) {
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
  }
}

/** 任务结束：放行（引用计数归零才真正停止） */
export function releaseKeepAwake(): void {
  if (refCount > 0) refCount--
  if (refCount === 0 && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}
