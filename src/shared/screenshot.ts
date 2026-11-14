// P1-4 截图进对话（第一刀）：共享常量与纯函数
//
// 主进程负责真正的捕获，这里只放**不依赖 Electron**的判定与换算，便于 node 环境直接单测：
// - 平台闸门（本刀只做 Windows）
// - desktopCapturer 返回的 source id 与前台窗口 HWND / 显示器 id 的匹配
// - 文件名与 data URL 字节数（10MB 附件上限要按真实字节判，不按字符串长度）
import type { ChatAttachment, ScreenshotTarget } from './types'

/** 图片附件上限（与渲染层 readFileAsAttachment 的 MAX_IMAGE_SIZE 同口径） */
export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024

/** 本刀只做 Windows；macOS/Linux 走 unsupported-platform 的可读原因 */
export function isScreenshotPlatformSupported(platform: string): boolean {
  return platform === 'win32'
}

/**
 * 在 desktopCapturer 的 window source id 里找前台窗口。
 * Windows 上 id 形如 `window:<HWND>:<tab>`（Electron 文档明示），HWND 段必须完全相等，
 * 不能拿字符串包含去猜（`window:123:0` 会误配 `window:1234:0`）。
 */
export function findWindowSourceId(hwnd: number, ids: readonly string[]): string | null {
  if (!Number.isInteger(hwnd) || hwnd <= 0) return null
  for (const id of ids) {
    const m = /^window:(\d+):/.exec(id)
    if (m && Number(m[1]) === hwnd) return id
  }
  return null
}

/**
 * 找目标显示器的 screen source：优先 display_id 精确匹配，
 * 匹配不到时退回第一个（多屏型号不同才会发生，至少保证整屏截图可用）。
 */
export function findScreenSourceId(
  displayId: string,
  sources: ReadonlyArray<{ id: string; displayId: string }>
): string | null {
  const hit = sources.find((s) => s.displayId === displayId)
  return hit?.id ?? sources[0]?.id ?? null
}

/** 截图附件文件名（本地时间；扩展开关跟随实际编码格式） */
export function screenshotFileName(target: ScreenshotTarget, at: Date, ext: 'png' | 'jpg' = 'png'): string {
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `moxia-${target}-${stamp}.${ext}`
}

/** data URL 里图片的真实字节数（base64 按 3/4 折算并扣掉 padding） */
export function screenshotDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/** 捕获结果 → 浮窗附件；保留为纯函数，便于用例直接构造期望值 */
export function screenshotAttachment(
  target: ScreenshotTarget,
  dataUrl: string,
  at: Date,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png'
): ChatAttachment {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png'
  return {
    type: 'image',
    name: screenshotFileName(target, at, ext),
    mimeType,
    size: screenshotDataUrlBytes(dataUrl),
    data: dataUrl
  }
}
