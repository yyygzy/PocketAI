// P1-4 截图进对话（第一刀）：Windows 当前活动窗口 / 整屏捕获
//
// 为什么不用 desktopCapturer：
//   `getSources({types:['window']})` 会为**所有**窗口按请求尺寸生成缩略图，几十个窗口 × 2MP
//   的瞬时内存与耗时都不可控；而这里只需要一个窗口。Windows 上直接用 Win32 `PrintWindow`
//   （PW_RENDERFULLCONTENT）按窗口真实像素抓，再用 DWM 可见边界裁掉 Win10/11 的不可见外框。
//
// 失败面按可读原因分码（no-window / empty / permission / too-large / failed），
// 上屏文案由渲染层按静态四语键映射，主进程只给码与排障日志。
// 捕获到的图只留在本机内存里，直到用户点发送才随消息走既有多模态附件链路。
import { app, nativeImage, type NativeImage } from 'electron'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger'
import { errMsg } from './error'
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

/**
 * PowerShell 捕获脚本：
 * - 先切到 per-monitor DPI 感知，否则 GetWindowRect / GetMonitorInfo 拿到的是被系统虚拟化过的坐标，
 *   150% / 200% 缩放下会裁掉右下角（这是本批最需要真机确认的一处）。
 * - window：PrintWindow(PW_RENDERFULLCONTENT=2) 抓整窗 → DWM 扩展边界（attr 9）裁可见区；
 *   全透明或 PrintWindow 失败时退回 CopyFromScreen（把被遮挡部分的真实可见画面抓下来）。
 * - screen：按鼠标所在显示器的物理矩形 CopyFromScreen。
 * - popupHwnd：浮窗自己的 HWND。真机实测：`win.hide()` 之后 Windows **不会**把前台改派给别的窗口，
 *   GetForegroundWindow 会一直返回这个已隐藏的浮窗（IsWindowVisible=false）。所以这里不等前台变化，
 *   而是用命中测试（WindowFromPoint + GetAncestor）取浮窗位置正下方的顶层窗口作为捕获目标。
 * 结果以一行 JSON 回传（stdout 最后一行）。
 */
export function buildScript(target: ScreenshotTarget, outFile: string, popupHwnd?: string): string {
  const psQuote = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MoxiaShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
function Emit($o) { $o | ConvertTo-Json -Compress }
function Is-FullyTransparent($bmp) {
  $sx = [Math]::Max(1, [int]($bmp.Width / 16))
  $sy = [Math]::Max(1, [int]($bmp.Height / 16))
  for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
    for ($y = 0; $y -lt $bmp.Height; $y += $sy) {
      if ($bmp.GetPixel($x, $y).A -ne 0) { return $false }
    }
  }
  return $true
}
try {
  try { [void][MoxiaShot]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][MoxiaShot]::SetProcessDPIAware() } catch {} }

  if (${psQuote(target)} -eq 'screen') {
    $pt = New-Object -TypeName 'MoxiaShot+POINT'
    [void][MoxiaShot]::GetCursorPos([ref]$pt)
    $mon = [MoxiaShot]::MonitorFromPoint($pt, 2)
    $mi = New-Object -TypeName 'MoxiaShot+MONITORINFO'
    $mi.cbSize = 40
    if (-not [MoxiaShot]::GetMonitorInfo($mon, [ref]$mi)) { Emit @{ ok = $false; code = 'failed'; detail = 'GetMonitorInfo' }; exit 0 }
    $w = $mi.rcMonitor.Right - $mi.rcMonitor.Left
    $h = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
    if ($w -le 0 -or $h -le 0) { Emit @{ ok = $false; code = 'empty' }; exit 0 }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($mi.rcMonitor.Left, $mi.rcMonitor.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $bmp.Save(${psQuote(outFile)}, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Emit @{ ok = $true; width = $w; height = $h }
    exit 0
  }

  $hwnd = [MoxiaShot]::GetForegroundWindow()
  $popupArg = ${psQuote(popupHwnd ?? '')}
  $popupHwndPtr = [IntPtr]::Zero
  if ($popupArg -ne '') { $popupHwndPtr = [IntPtr]([Int64]$popupArg) }
  if (($popupHwndPtr -ne [IntPtr]::Zero) -and ($hwnd -eq $popupHwndPtr)) {
    # 前台仍是已隐藏的浮窗（Windows 不会改派）：取浮窗中心点正下方的顶层窗口
    $popupRect = New-Object -TypeName 'MoxiaShot+RECT'
    if (-not [MoxiaShot]::GetWindowRect($popupHwndPtr, [ref]$popupRect)) {
      Emit @{ ok = $false; code = 'no-window'; detail = 'popup rect unavailable' }
      exit 0
    }
    $pt = New-Object -TypeName 'MoxiaShot+POINT'
    $pt.X = [int](($popupRect.Left + $popupRect.Right) / 2)
    $pt.Y = [int](($popupRect.Top + $popupRect.Bottom) / 2)
    $hit = [MoxiaShot]::WindowFromPoint($pt)
    $root = [IntPtr]::Zero
    if ($hit -ne [IntPtr]::Zero) { $root = [MoxiaShot]::GetAncestor($hit, 2) }
    if (($root -eq [IntPtr]::Zero) -or ($root -eq $popupHwndPtr) -or (-not [MoxiaShot]::IsWindowVisible($root))) {
      Emit @{ ok = $false; code = 'no-window'; detail = 'no window under popup' }
      exit 0
    }
    $hwnd = $root
  }
  if ($hwnd -eq [IntPtr]::Zero) { Emit @{ ok = $false; code = 'no-window' }; exit 0 }
  # 桌面/任务栏不是"窗口"，按无窗口处理
  $cls = New-Object System.Text.StringBuilder 260
  [void][MoxiaShot]::GetClassName($hwnd, $cls, 260)
  if (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -contains $cls.ToString()) {
    Emit @{ ok = $false; code = 'no-window'; detail = 'desktop' }
    exit 0
  }
  $wr = New-Object -TypeName 'MoxiaShot+RECT'
  if (-not [MoxiaShot]::GetWindowRect($hwnd, [ref]$wr)) { Emit @{ ok = $false; code = 'no-window' }; exit 0 }
  $fullW = $wr.Right - $wr.Left
  $fullH = $wr.Bottom - $wr.Top
  if ($fullW -le 0 -or $fullH -le 0) { Emit @{ ok = $false; code = 'no-window' }; exit 0 }

  # DWM 可见边界（Win10/11 的窗口外框有约 8px 不可见拖拽边）
  $visible = $false
  $vx = 0; $vy = 0; $vw = $fullW; $vh = $fullH
  $vr = New-Object -TypeName 'MoxiaShot+RECT'
  $hr = [MoxiaShot]::DwmGetWindowAttribute($hwnd, 9, [ref]$vr, 16)
  if (($hr -eq 0) -and (($vr.Right - $vr.Left) -gt 0) -and (($vr.Bottom - $vr.Top) -gt 0)) {
    $visible = $true
    $vx = $vr.Left - $wr.Left
    $vy = $vr.Top - $wr.Top
    $vw = $vr.Right - $vr.Left
    $vh = $vr.Bottom - $vr.Top
  }

  $full = New-Object System.Drawing.Bitmap($fullW, $fullH)
  $g = [System.Drawing.Graphics]::FromImage($full)
  $hdc = $g.GetHdc()
  $printed = [MoxiaShot]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()

  $bmp = $null
  if ($printed -and $visible) {
    $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $vw, $vh)), (New-Object System.Drawing.Rectangle($vx, $vy, $vw, $vh)), [System.Drawing.GraphicsUnit]::Pixel)
    $g2.Dispose()
  } elseif ($printed) {
    $bmp = $full
  }
  if ($bmp -ne $full) { $full.Dispose() }

  if (($null -eq $bmp) -or (Is-FullyTransparent $bmp)) {
    if ($null -ne $bmp) { $bmp.Dispose() }
    $sx = $wr.Left; $sy = $wr.Top; $cw = $fullW; $ch = $fullH
    if ($visible) { $sx = $wr.Left + $vx; $sy = $wr.Top + $vy; $cw = $vw; $ch = $vh }
    $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $g3 = [System.Drawing.Graphics]::FromImage($bmp)
    $g3.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
    $g3.Dispose()
  }

  $bmp.Save(${psQuote(outFile)}, [System.Drawing.Imaging.ImageFormat]::Png)
  $w = $bmp.Width; $h = $bmp.Height
  $bmp.Dispose()
  Emit @{ ok = $true; width = $w; height = $h }
  exit 0
} catch {
  Emit @{ ok = $false; code = 'failed'; detail = $_.Exception.Message }
  exit 0
}
`
}

interface ProbeResult {
  ok: boolean
  code?: string
  detail?: string
}

function runScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${errMsg(err)}${stderr ? `: ${String(stderr).slice(0, 500)}` : ''}`))
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

function parseProbe(stdout: string): ProbeResult | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.startsWith('{')) continue
    try {
      const v = JSON.parse(line) as { ok?: unknown; code?: unknown; detail?: unknown }
      return {
        ok: v.ok === true,
        code: typeof v.code === 'string' ? v.code : undefined,
        detail: typeof v.detail === 'string' ? v.detail : undefined
      }
    } catch {
      // 继续往前找（Add-Type 等步骤可能往 stdout 打过别的东西）
    }
  }
  return null
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

export function encodeCapture(target: ScreenshotTarget, buf: Buffer, at: Date): ScreenshotCaptureResult {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return { ok: false, code: 'empty' }
  const size = img.getSize()
  if (size.width <= 0 || size.height <= 0) return { ok: false, code: 'empty' }
  if (isFullyTransparent(img)) return { ok: false, code: 'empty' }
  // 隐藏/受保护窗口的黑帧：不当成功，给出可读原因
  if (isNearBlackImage(img)) return { ok: false, code: 'black' }

  let dataUrl = img.toDataURL()
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
 * 调用方负责先隐藏浮窗；`popupHwnd` 是浮窗自己的原生句柄——Windows 在 hide() 之后不会改派前台，
 * 抓图脚本靠它识别"前台仍是被隐藏的浮窗"，再按命中测试改抓浮窗正下方的窗口。
 */
export async function captureScreenshot(
  target: ScreenshotTarget,
  opts: { popupHwnd?: string } = {}
): Promise<ScreenshotCaptureResult> {
  if (!isScreenshotPlatformSupported(process.platform)) {
    return { ok: false, code: 'unsupported-platform' }
  }
  const outFile = path.join(
    app.getPath('temp'),
    `moxia-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  )
  try {
    const stdout = await runScript(buildScript(target, outFile, opts.popupHwnd))
    const probe = parseProbe(stdout)
    if (!probe) throw new Error('capture script returned no result')
    if (!probe.ok) {
      log.warn(`截图未完成(${target}):`, probe.code ?? 'unknown', probe.detail ?? '')
      return { ok: false, code: normalizeFailCode(probe.code), detail: probe.detail }
    }
    const buf = await fs.readFile(outFile)
    const result = encodeCapture(target, buf, new Date())
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
