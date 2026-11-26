// P1-4 第二刀：macOS 整屏/区域取图。
//
// Electron 在 macOS 10.15+ 要求「屏幕录制」授权；`askForMediaAccess` 不支持 screen，
// 所以这里只做状态预判 + 首次 getSources 触发系统弹窗，被拒就给 permission 码，不假装在截图。
// 只取 screen source：窗口目标在 macOS 上退化为整屏（由调用方在注释/文案里说明），
// 不把 Windows 的 HWND 匹配口径误用到 macOS。
import { desktopCapturer, screen, systemPreferences } from 'electron'
import { findScreenSourceId } from '../shared/screenshot'
import type { ScreenshotFailCode, ScreenshotRect, ScreenshotTarget } from '../shared/types'

export interface MacGrabSuccess {
  ok: true
  buffer: Buffer
  scaleFactor: number
  displayId: string
  /** 实际取图尺寸（物理像素），便于 region 换算 */
  width: number
  height: number
}

export interface MacGrabFailure {
  ok: false
  code: ScreenshotFailCode
  detail?: string
}

export type MacGrabResult = MacGrabSuccess | MacGrabFailure

/** 目标窗口在 macOS 没有可靠的按需窗口抓取路径；统一退回整屏，不静默假装抓到了某窗口 */
export function macCaptureTarget(_target: ScreenshotTarget): 'screen' {
  return 'screen'
}

export async function grabMacOSScreen(
  target: ScreenshotTarget,
  _rect?: ScreenshotRect
): Promise<MacGrabResult> {
  try {
    const status = systemPreferences.getMediaAccessStatus?.('screen')
    if (status === 'denied' || status === 'restricted') {
      return {
        ok: false,
        code: 'permission',
        detail: 'macOS 屏幕录制权限未授予：系统设置 → 隐私与安全性 → 屏幕录制'
      }
    }

    // void _rect：区域裁剪统一在 screenshot.ts 里做（Windows/macOS 共用 scaleFactor 口径）
    void _rect
    void target
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const scaleFactor = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0
      ? display.scaleFactor
      : 1
    const width = Math.max(1, Math.round(display.bounds.width * scaleFactor))
    const height = Math.max(1, Math.round(display.bounds.height * scaleFactor))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    })
    const id = findScreenSourceId(
      String(display.id),
      sources.map((s) => ({ id: s.id, displayId: String(s.display_id ?? '') }))
    )
    const source = sources.find((s) => s.id === id)
    if (!source) return { ok: false, code: 'no-window' }

    const buffer = source.thumbnail.toPNG()
    if (!buffer || buffer.length === 0) return { ok: false, code: 'empty' }
    return { ok: true, buffer, scaleFactor, displayId: String(display.id), width, height }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      code: /denied|permission|not authorized/i.test(msg) ? 'permission' : 'failed',
      detail: msg
    }
  }
}
