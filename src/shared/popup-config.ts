// 快捷浮窗的快捷键配置判定（纯函数，可单测）
// 注册占用（globalShortcut.register 返回 false）只能在主进程发现，这里只管**配置自身**的冲突：
// 已启用的入口之间不允许共用同一个 accelerator，否则后注册的那个会静默顶掉前一个。
import type { PopupConfig } from './types'

type AccelConfig = Pick<
  PopupConfig,
  | 'quickEnabled'
  | 'selectionEnabled'
  | 'screenshotEnabled'
  | 'quickAccelerator'
  | 'selectionAccelerator'
  | 'screenshotAccelerator'
>

/** 返回被重复使用的 accelerator；没有冲突返回 null。空串不参与比较（空是非法值，交给注册阶段报 occupied） */
export function popupAccelConflict(cfg: AccelConfig): string | null {
  const enabled: string[] = []
  if (cfg.quickEnabled) enabled.push(cfg.quickAccelerator.trim())
  if (cfg.selectionEnabled) enabled.push(cfg.selectionAccelerator.trim())
  if (cfg.screenshotEnabled) enabled.push(cfg.screenshotAccelerator.trim())

  const seen = new Set<string>()
  for (const accel of enabled) {
    if (!accel) continue
    if (seen.has(accel)) return accel
    seen.add(accel)
  }
  return null
}
