// 界面偏好管理
//
// ui.opacity     窗口透明度（0.6–1），主进程 BrowserWindow.setOpacity
//                Windows / macOS 原生支持；Linux 取决于窗口管理器（不支持时静默无效）
// ui.custom_css  自定义 CSS 文本，渲染端读取后注入 <style>，主进程只负责存取
//
// 安全：CSS 仅作用于本应用渲染进程沙箱，不接触 Node API；限制长度防止误塞大内容。

import { BrowserWindow } from 'electron'
import { appConfigRepo } from './db/repositories/app-config.repo'
import type { UiPreferences } from '../shared/types'

const K_OPACITY = 'ui.opacity'
const K_CUSTOM_CSS = 'ui.custom_css'

export const MIN_OPACITY = 0.6
export const MAX_OPACITY = 1
export const MAX_CSS_LENGTH = 200_000

const MAIN_WINDOW_TITLE = '墨匣'

function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, v))
}

export function getUiPreferences(): UiPreferences {
  const raw = Number(appConfigRepo.get(K_OPACITY))
  return {
    opacity: Number.isFinite(raw) && raw > 0 ? clampOpacity(raw) : 1,
    customCss: appConfigRepo.get(K_CUSTOM_CSS) ?? ''
  }
}

/** 保存偏好（部分更新），并立即把透明度应用到主窗口 */
export function setUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
  if (patch.opacity !== undefined) {
    appConfigRepo.set(K_OPACITY, String(clampOpacity(patch.opacity)))
  }
  if (patch.customCss !== undefined) {
    const css = patch.customCss.slice(0, MAX_CSS_LENGTH)
    appConfigRepo.set(K_CUSTOM_CSS, css)
  }
  const next = getUiPreferences()
  applyOpacityToMainWindows(next.opacity)
  return next
}

/** 对所有主窗口应用透明度（排除浮窗 / 解锁窗） */
export function applyOpacityToMainWindows(opacity?: number): void {
  const value = opacity ?? getUiPreferences().opacity
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (win.getTitle() !== MAIN_WINDOW_TITLE) continue
    try {
      win.setOpacity(value)
    } catch {
      /* 平台不支持时静默忽略 */
    }
  }
}
