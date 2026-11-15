// 常驻截图宿主（Windows）
//
// 真机实测：本机每次拉起 powershell.exe（-NoProfile）约 5.7–7.4s，脚本里的
// `Add-Type -TypeDefinition` 编译 C# 还要 2.6–3.1s。两者合计占了热键到附件 13–27s 的绝大部分，
// 而与窗口大小无关。所以把这两件事从"每次捕获"挪到"应用启动后一次"：
//   - 启动时 spawn 一个 powershell.exe，编译一次 C#，之后通过 stdin/stdout 收发 JSON 行；
//   - `foreground` 命令在热键瞬间取前台 HWND（很快），避免浮窗上屏后目标漂移；
//   - `capture` 命令复用已编译好的类型，只做取目标 / PrintWindow / 存 PNG。
// 宿主崩溃或超时会被杀掉，下次捕获自动重启（此时要再付一次冷启动成本）。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createLogger } from './logger'
import { errMsg } from './error'
import type { ScreenshotTarget } from '../shared/types'

const log = createLogger('screenshot-host')

// 启动（PowerShell 拉起 + Add-Type 编译 C#）在真机冷缓存/高负载下见过 31.6s，给足 60s；
// 这只是上限，正常 5.7–7.4s 返回 ready 就开始服务。
const HOST_START_TIMEOUT_MS = 60_000
const HOST_REQUEST_TIMEOUT_MS = 20_000

/** 宿主返回的一条消息（事件或响应；id 只在响应里有） */
export interface HostMessage {
  event?: string
  id?: number
  ok?: boolean
  code?: string
  detail?: string
  width?: number
  height?: number
  hwnd?: string
  msTarget?: number
  msGrab?: number
  msSave?: number
  msTotal?: number
  epoch?: number
}

export interface HostRequest {
  cmd: 'foreground' | 'capture'
  target?: ScreenshotTarget
  out?: string
  /** 热键瞬间记录的前台窗口；有它就不再依赖捕获时的前台 */
  targetHwnd?: string
  /** 浮窗句柄：前台若是浮窗，用命中测试取正下方窗口 */
  popupHwnd?: string
}

/**
 * stdout 行协议：按 \n 切分，只保留完整行，最后一段留到下次。
 * 非 JSON 行（Add-Type 的噪音、警告）直接丢弃；单行解析失败不拖垮整批。
 */
export function takeHostLines(buffer: string): { messages: HostMessage[]; rest: string } {
  const parts = buffer.split(/\r?\n/)
  const rest = parts.pop() ?? ''
  const messages: HostMessage[] = []
  for (const line of parts) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      messages.push(JSON.parse(text) as HostMessage)
    } catch {
      // 半行/噪声：跳过
    }
  }
  return { messages, rest }
}

/** -EncodedCommand 要求 base64(UTF-16LE)；命令行走 CreateProcess 的 32K 上限 */
export function encodeHostScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 宿主脚本：C# 只编译一次；之后从 stdin 逐行读 JSON 命令。
 * 事件：启动完成发 `{"event":"ready"}`；需要主进程先把浮窗藏掉再抓屏时发
 * `{"event":"fallback","id":N}`，随后等 250ms 再 CopyFromScreen。
 */
export function buildHostScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
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
try { [void][MoxiaShot]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][MoxiaShot]::SetProcessDPIAware() } catch {} }

function Emit($o) {
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

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

function Resolve-Target($targetHwndArg, $popupHwndArg) {
  $popupPtr = [IntPtr]::Zero
  if ($popupHwndArg -and ($popupHwndArg -ne '')) { $popupPtr = [IntPtr]([Int64]$popupHwndArg) }
  $hwnd = [IntPtr]::Zero
  if ($targetHwndArg -and ($targetHwndArg -ne '')) { $hwnd = [IntPtr]([Int64]$targetHwndArg) }
  # 没有显式目标时退回"当前前台"（📷 入口 / 旧调用方）
  if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [MoxiaShot]::GetForegroundWindow() }
  if (($popupPtr -ne [IntPtr]::Zero) -and ($hwnd -eq $popupPtr)) {
    # 前台是浮窗：取浮窗中心点正下方的顶层窗口（Windows 隐藏后不会改派前台）
    $popupRect = New-Object -TypeName 'MoxiaShot+RECT'
    if (-not [MoxiaShot]::GetWindowRect($popupPtr, [ref]$popupRect)) {
      return @{ ok = $false; code = 'no-window'; detail = 'popup rect unavailable' }
    }
    $pt = New-Object -TypeName 'MoxiaShot+POINT'
    $pt.X = [int](($popupRect.Left + $popupRect.Right) / 2)
    $pt.Y = [int](($popupRect.Top + $popupRect.Bottom) / 2)
    $hit = [MoxiaShot]::WindowFromPoint($pt)
    $root = [IntPtr]::Zero
    if ($hit -ne [IntPtr]::Zero) { $root = [MoxiaShot]::GetAncestor($hit, 2) }
    if (($root -eq [IntPtr]::Zero) -or ($root -eq $popupPtr) -or (-not [MoxiaShot]::IsWindowVisible($root))) {
      return @{ ok = $false; code = 'no-window'; detail = 'no window under popup' }
    }
    $hwnd = $root
  }
  if ($hwnd -eq [IntPtr]::Zero) { return @{ ok = $false; code = 'no-window' } }
  # 目标在热键后被关掉/隐藏：按无窗口报，不要截一张黑图
  if (-not [MoxiaShot]::IsWindowVisible($hwnd)) {
    return @{ ok = $false; code = 'no-window'; detail = 'target not visible' }
  }
  # 桌面/任务栏不是"窗口"
  $cls = New-Object System.Text.StringBuilder 260
  [void][MoxiaShot]::GetClassName($hwnd, $cls, 260)
  if (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -contains $cls.ToString()) {
    return @{ ok = $false; code = 'no-window'; detail = 'desktop' }
  }
  return @{ ok = $true; hwnd = $hwnd }
}

function Capture-Screen($req, $sw) {
  $pt = New-Object -TypeName 'MoxiaShot+POINT'
  [void][MoxiaShot]::GetCursorPos([ref]$pt)
  $mon = [MoxiaShot]::MonitorFromPoint($pt, 2)
  $mi = New-Object -TypeName 'MoxiaShot+MONITORINFO'
  $mi.cbSize = 40
  if (-not [MoxiaShot]::GetMonitorInfo($mon, [ref]$mi)) {
    Emit @{ id = $req.id; ok = $false; code = 'failed'; detail = 'GetMonitorInfo' }
    return
  }
  $w = $mi.rcMonitor.Right - $mi.rcMonitor.Left
  $h = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
  if ($w -le 0 -or $h -le 0) { Emit @{ id = $req.id; ok = $false; code = 'empty' }; return }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($mi.rcMonitor.Left, $mi.rcMonitor.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($req.out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Emit @{ id = $req.id; ok = $true; width = $w; height = $h; msTotal = $sw.ElapsedMilliseconds }
}

function Capture-Window($req, $sw, $epoch) {
  $resolved = Resolve-Target $req.targetHwnd $req.popupHwnd
  $tTarget = $sw.ElapsedMilliseconds
  if (-not $resolved.ok) {
    Emit @{ id = $req.id; ok = $false; code = $resolved.code; detail = $resolved.detail; msTarget = $tTarget; msTotal = $sw.ElapsedMilliseconds; epoch = $epoch }
    return
  }
  $hwnd = $resolved.hwnd
  $wr = New-Object -TypeName 'MoxiaShot+RECT'
  if (-not [MoxiaShot]::GetWindowRect($hwnd, [ref]$wr)) {
    Emit @{ id = $req.id; ok = $false; code = 'no-window'; msTotal = $sw.ElapsedMilliseconds; epoch = $epoch }
    return
  }
  $fullW = $wr.Right - $wr.Left
  $fullH = $wr.Bottom - $wr.Top
  if ($fullW -le 0 -or $fullH -le 0) {
    Emit @{ id = $req.id; ok = $false; code = 'no-window'; msTotal = $sw.ElapsedMilliseconds; epoch = $epoch }
    return
  }

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
    # 兜底要抓屏幕：浮窗如果还在屏上会挡在目标窗口前面，先让主进程藏掉
    Emit @{ event = 'fallback'; id = $req.id }
    Start-Sleep -Milliseconds 250
    $sx = $wr.Left; $sy = $wr.Top; $cw = $fullW; $ch = $fullH
    if ($visible) { $sx = $wr.Left + $vx; $sy = $wr.Top + $vy; $cw = $vw; $ch = $vh }
    $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
    $g3 = [System.Drawing.Graphics]::FromImage($bmp)
    $g3.CopyFromScreen($sx, $sy, 0, 0, (New-Object System.Drawing.Size($cw, $ch)))
    $g3.Dispose()
  }

  $tGrab = $sw.ElapsedMilliseconds
  $bmp.Save($req.out, [System.Drawing.Imaging.ImageFormat]::Png)
  $tSave = $sw.ElapsedMilliseconds
  $w = $bmp.Width; $h = $bmp.Height
  $bmp.Dispose()
  Emit @{ id = $req.id; ok = $true; width = $w; height = $h; msTarget = $tTarget; msGrab = $tGrab; msSave = $tSave; msTotal = $sw.ElapsedMilliseconds; epoch = $epoch }
}

Emit @{ event = 'ready' }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $req = $null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  try {
    $req = ConvertFrom-Json $line
    if ($req.cmd -eq 'foreground') {
      $h = [MoxiaShot]::GetForegroundWindow()
      Emit @{ id = $req.id; ok = $true; hwnd = "$h" }
    } elseif ($req.cmd -eq 'capture') {
      if ($req.target -eq 'screen') { Capture-Screen $req $sw }
      else { Capture-Window $req $sw $epoch }
    } else {
      Emit @{ id = $req.id; ok = $false; code = 'failed'; detail = 'unknown command' }
    }
  } catch {
    $rid = $null
    if ($null -ne $req) { $rid = $req.id }
    Emit @{ id = $rid; ok = $false; code = 'failed'; detail = $_.Exception.Message; msTotal = $sw.ElapsedMilliseconds }
  }
}
`
}

interface PendingRequest {
  id: number
  resolve: (msg: HostMessage) => void
  reject: (err: Error) => void
  onFallback?: () => void
  timer: NodeJS.Timeout
}

export class CaptureHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private startPromise: Promise<void> | null = null
  private startTimer: NodeJS.Timeout | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((err: Error) => void) | null = null
  private startedAt = 0
  private ready = false
  private disposed = false
  private buffer = ''
  private seq = 0
  private pending: PendingRequest | null = null
  private chain: Promise<unknown> = Promise.resolve()

  isReady(): boolean {
    return this.ready
  }

  /** 应用启动后预热点：把 PowerShell 启动与 C# 编译的 8–10s 挪到用户看不见的时候 */
  prewarm(): void {
    void this.ensureReady().catch(() => {
      // 预热失败不打扰用户；真正捕获时会再试并返回可读失败
    })
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('capture host disposed'))
    if (this.ready) return Promise.resolve()
    if (!this.startPromise) this.startPromise = this.start()
    return this.startPromise
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buffer = ''
      this.startedAt = Date.now()
      this.startResolve = resolve
      this.startReject = reject
      const encoded = encodeHostScript(buildHostScript())
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
      } catch (e) {
        this.failStart(new Error(errMsg(e)))
        return
      }
      this.child = child
      this.startTimer = setTimeout(() => this.failStart(new Error('capture host start timeout')), HOST_START_TIMEOUT_MS)
      this.startTimer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim()
        if (text) log.warn('capture host stderr:', text.slice(0, 400))
      })
      child.on('error', (e) => this.onExit(errMsg(e)))
      child.on('exit', (code, signal) => {
        this.onExit(`capture host exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      })
    })
  }

  private failStart(err: Error): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    const reject = this.startReject
    this.startResolve = null
    this.startReject = null
    this.startPromise = null
    this.kill()
    reject?.(err)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    const { messages, rest } = takeHostLines(this.buffer)
    this.buffer = rest
    for (const msg of messages) {
      if (msg.event === 'ready') {
        this.ready = true
        // 这一步（PowerShell 启动 + Add-Type）过去每次捕获都要付 8–10s，现在只在启动时付一次
        log.info(`capture host ready in ${Date.now() - this.startedAt}ms`)
        if (this.startTimer) {
          clearTimeout(this.startTimer)
          this.startTimer = null
        }
        const resolve = this.startResolve
        this.startResolve = null
        this.startReject = null
        resolve?.()
        continue
      }
      if (msg.event === 'fallback') {
        try {
          this.pending?.onFallback?.()
        } catch (e) {
          log.warn('fallback handler failed:', errMsg(e))
        }
        continue
      }
      const pending = this.pending
      if (pending && msg.id === pending.id) {
        clearTimeout(pending.timer)
        this.pending = null
        pending.resolve(msg)
      }
    }
  }

  private onExit(reason: string): void {
    const wasReady = this.ready
    this.ready = false
    this.child = null
    this.buffer = ''
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    if (this.startReject) {
      const reject = this.startReject
      this.startResolve = null
      this.startReject = null
      reject(new Error(reason))
    }
    this.startPromise = null
    const pending = this.pending
    if (pending) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.reject(new Error(reason))
    }
    if (wasReady && !this.disposed) log.warn(reason)
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.ready = false
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // 进程可能已经退出
      }
    }
  }

  request(req: HostRequest, timeoutMs = HOST_REQUEST_TIMEOUT_MS, onFallback?: () => void): Promise<HostMessage> {
    const run = this.chain.then(() => this.send(req, timeoutMs, onFallback))
    this.chain = run.catch(() => {
      // 单次失败不阻塞后续请求
    })
    return run
  }

  private async send(req: HostRequest, timeoutMs: number, onFallback?: () => void): Promise<HostMessage> {
    await this.ensureReady()
    const child = this.child
    if (!child || !child.stdin.writable) throw new Error('capture host not writable')
    const id = ++this.seq
    return new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.id === id) {
          this.pending = null
          // 卡住的 PrintWindow 会堵死宿主：直接杀掉，下次请求重新拉起
          this.kill()
          this.startPromise = null
          reject(new Error('capture host request timeout'))
        }
      }, timeoutMs)
      timer.unref?.()
      this.pending = { id, resolve, reject, onFallback, timer }
      child.stdin.write(JSON.stringify({ ...req, id }) + '\n')
    })
  }

  dispose(): void {
    this.disposed = true
    const pending = this.pending
    if (pending) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.reject(new Error('capture host disposed'))
    }
    if (this.startReject) {
      const reject = this.startReject
      this.startResolve = null
      this.startReject = null
      reject(new Error('capture host disposed'))
    }
    this.startPromise = null
    this.kill()
  }
}
