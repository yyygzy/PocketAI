// P1-4 截图进对话（第一刀）：Windows 当前活动窗口 / 整屏捕获
//
// 为什么不用 desktopCapturer：
//   `getSources({types:['window']})` 会为**所有**窗口按请求尺寸生成缩略图，几十个窗口 × 2MP
//   的瞬时内存与耗时都不可控；而这里只需要一个窗口。Windows 上直接用 Win32 `PrintWindow`
//   （PW_RENDERFULLCONTENT）按窗口真实像素抓，再用 DWM 可见边界裁掉 Win10/11 的不可见外框。
//
// 为什么不用一次性 PowerShell：真机实测每次拉起约 5.7–7.4s，`Add-Type` 编译 C# 还要
// 2.6–3.1s，与窗口大小无关。现在交给常驻宿主（screenshot-host.ts），启动时编译一次，
// 捕获只做取目标 / PrintWindow / 存 PNG。
//
// 失败面按可读原因分码（no-window / empty / permission / black / too-large / failed），
// 上屏文案由渲染层按静态四语键映射，主进程只给码与排障日志。
// 捕获到的图只留在本机内存里，直到用户点发送才随消息走既有多模态附件链路。
import { app, nativeImage, type NativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'
import { errMsg } from './error'
import { CaptureHost } from './screenshot-host'
import {
  isScreenshotPlatformSupported,
  screenshotAttachment,
  screenshotDataUrlBytes,
  SCREENSHOT_MAX_BYTES
} from '../shared/screenshot'
import type { ScreenshotCaptureResult, ScreenshotFailCode, ScreenshotTarget } from '../shared/types'

const log = createLogger('screenshot')

/**
 * 取窗口的原生 HWND（十进制字符串）。
 *
 * 真机实测（Windows 11 / 250% 缩放）：`win.hide()` 之后 Windows **不会**把前台改派给别的窗口——
 * GetForegroundWindow 会一直返回这个已隐藏的浮窗（IsWindowVisible=false），且可稳定持续 2s 以上。
 * 所以"隐藏后等前台变化再截图"这条路走不通；改成把浮窗句柄交给捕获脚本，由脚本用命中测试
 * （浮窗中心 → WindowFromPoint → GetAncestor）取浮窗正下方的窗口作为捕获目标。
 */
export function popupHwndString(
  win: { isDestroyed(): boolean; getNativeWindowHandle(): Buffer } | null
): string | undefined {
  if (!win || win.isDestroyed()) return undefined
  try {
    const buf = win.getNativeWindowHandle()
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString()
    if (buf.length >= 4) return String(buf.readUInt32LE(0))
  } catch {
    // 拿不到句柄：退回"前台窗口"路径（浮窗不在前台时依然成立）
  }
  return undefined
}

// ─── 常驻捕获宿主 ───────────────────────────────────────────────────

let captureHost: CaptureHost | null = null

function getCaptureHost(): CaptureHost {
  if (!captureHost) {
    captureHost = new CaptureHost()
    try {
      app.once('will-quit', () => {
        captureHost?.dispose()
        captureHost = null
      })
    } catch {
      // 测试环境可能只给 app 打了最小桩
    }
  }
  return captureHost
}

/** 启动后预热：把 PowerShell 启动与 C# 编译挪到用户看不见的时候 */
export function prewarmCaptureHost(): void {
  if (!isScreenshotPlatformSupported(process.platform)) return
  getCaptureHost().prewarm()
}

/**
 * 热键按下瞬间的前台窗口。
 * 浮窗上屏会抢走前台，所以必须在 show 之前取；拿到后即使浮窗盖住目标也能按 HWND 取源。
 */
export async function queryForegroundHwnd(): Promise<string | undefined> {
  const resp = await getCaptureHost().request({ cmd: 'foreground' })
  return resp.ok && typeof resp.hwnd === 'string' && resp.hwnd !== '0' ? resp.hwnd : undefined
}

const FAIL_CODES = new Set<ScreenshotFailCode>([
  'unsupported-platform',
  'locked',
  'no-window',
  'permission',
  'empty',
  'black',
  'too-large',
  'failed'
])

function normalizeFailCode(code: unknown): ScreenshotFailCode {
  return typeof code === 'string' && FAIL_CODES.has(code as ScreenshotFailCode)
    ? (code as ScreenshotFailCode)
    : 'failed'
}

/** 全透明位图＝窗口没被画出来（PW 对部分受保护/硬件加速窗口会这样），按"捕获为空"报 */
function isFullyTransparent(img: NativeImage): boolean {
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return true
  let bitmap: Buffer
  try {
    bitmap = img.toBitmap() // BGRA
  } catch {
    return false
  }
  if (bitmap.length < width * height * 4) return false
  const step = Math.max(1, Math.floor((width * height) / 2048))
  for (let i = 0; i < width * height; i += step) {
    if (bitmap[i * 4 + 3] !== 0) return false
  }
  return true
}

/**
 * 全黑帧识别（导出仅供定向测试）。
 *
 * PrintWindow 对隐藏 / 受保护 / 尚未渲染的窗口经常返回一张纯黑位图，而 alpha 仍是 255，
 * 只查"是否全透明"会把黑图当成功。这里对采样点要求**全部**近黑（RGB 各 ≤ 4）才算黑帧：
 * 深色主题的窗口里总有文字、边框或面板色，只要有一个非黑像素就放行，不会误伤真实截图。
 */
export function isNearBlackImage(img: NativeImage): boolean {
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return false
  let bitmap: Buffer
  try {
    bitmap = img.toBitmap()
  } catch {
    return false
  }
  const total = width * height
  if (bitmap.length < total * 4) return false
  const step = Math.max(1, Math.floor(total / 4096))
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    if (bitmap[o]! > 4 || bitmap[o + 1]! > 4 || bitmap[o + 2]! > 4) return false
  }
  return true
}

/**
 * 校验并生成附件。
 *
 * PNG 编码不再交给 Electron 重做：宿主已经把 PNG 落盘，直接 base64 文件字节即可
 * （真机 2974×1987 实测 `toDataURL()` 要 270–530ms，白等）。校验仍需解码，
 * 但 `createFromBuffer` + 采样约 150ms；只有超过 10MB 上限时才退回 toJPEG。
 */
export function encodeCapture(target: ScreenshotTarget, buf: Buffer, at: Date): ScreenshotCaptureResult {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return { ok: false, code: 'empty' }
  const size = img.getSize()
  if (size.width <= 0 || size.height <= 0) return { ok: false, code: 'empty' }
  if (isFullyTransparent(img)) return { ok: false, code: 'empty' }
  // 隐藏/受保护窗口的黑帧：不当成功，给出可读原因
  if (isNearBlackImage(img)) return { ok: false, code: 'black' }

  let dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  let mimeType: 'image/png' | 'image/jpeg' = 'image/png'
  // 与附件链路同一个 10MB 上限：PNG 超限先转 JPEG；仍超限就如实报，不硬塞
  if (screenshotDataUrlBytes(dataUrl) > SCREENSHOT_MAX_BYTES) {
    const jpeg = img.toJPEG(88)
    if (jpeg.length > 0) {
      dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`
      mimeType = 'image/jpeg'
    }
  }
  const bytes = screenshotDataUrlBytes(dataUrl)
  if (bytes > SCREENSHOT_MAX_BYTES) return { ok: false, code: 'too-large' }

  return {
    ok: true,
    target,
    width: size.width,
    height: size.height,
    attachment: screenshotAttachment(target, dataUrl, at, mimeType)
  }
}

/**
 * 捕获一次。
 *
 * - `targetHwnd`：热键瞬间记录的前台窗口；有它就不再依赖捕获时的前台，浮窗可以边抓边显示。
 * - `popupHwnd`：浮窗句柄；当前台是浮窗时（📷 入口 / 浮窗可见时按热键）走命中测试。
 * - `onFallback`：脚本需要 CopyFromScreen 兜底时会先要主进程把浮窗藏掉，避免把浮窗截进去。
 */
export async function captureScreenshot(
  target: ScreenshotTarget,
  opts: { popupHwnd?: string; targetHwnd?: string; onFallback?: () => void } = {}
): Promise<ScreenshotCaptureResult> {
  if (!isScreenshotPlatformSupported(process.platform)) {
    return { ok: false, code: 'unsupported-platform' }
  }
  const outFile = path.join(
    app.getPath('temp'),
    `moxia-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  )
  const startedAt = Date.now()
  try {
    const resp = await getCaptureHost().request(
      { cmd: 'capture', target, out: outFile, targetHwnd: opts.targetHwnd, popupHwnd: opts.popupHwnd },
      undefined,
      opts.onFallback
    )
    if (!resp.ok) {
      log.warn(`截图未完成(${target}):`, resp.code ?? 'unknown', resp.detail ?? '')
      return { ok: false, code: normalizeFailCode(resp.code), detail: resp.detail }
    }
    const readStart = Date.now()
    const buf = await fs.readFile(outFile)
    const readMs = Date.now() - readStart
    const encStart = Date.now()
    const result = encodeCapture(target, buf, new Date())
    const encodeMs = Date.now() - encStart
    log.debug('[perf] capture', JSON.stringify({
      target,
      explicitTarget: Boolean(opts.targetHwnd),
      hostWallMs: Date.now() - startedAt,
      targetMs: resp.msTarget,
      grabMs: resp.msGrab,
      saveMs: resp.msSave,
      scriptTotalMs: resp.msTotal,
      readFileMs: readMs,
      encodeMs,
      fileBytes: buf.length,
      finishedEpoch: Date.now()
    }))
    if (!result.ok) log.warn(`截图结果不可用(${target}):`, result.code)
    return result
  } catch (e) {
    const msg = errMsg(e)
    log.warn(`截图失败(${target}):`, msg)
    return {
      ok: false,
      code: /denied|permission|access|not authorized/i.test(msg) ? 'permission' : 'failed',
      detail: msg
    }
  } finally {
    await fs.unlink(outFile).catch(() => {
      // 临时文件清理失败不影响主流程
    })
  }
}
