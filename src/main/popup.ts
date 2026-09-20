// 快捷浮窗（v1 尾巴）：快捷问答 + 选区助手
//
// 设计要点（参考多窗口踩坑经验）：
// 1. 全应用唯一浮窗实例，所有入口（快捷键/选区）收敛到 openPopup() 幂等函数：
//    已存在 → show+focus+换 payload；不存在 → new。杜绝"按一次弹三个"。
// 2. 无边框透明置顶窗口，skipTaskbar；失焦/Esc 隐藏（Spotlight 式），hide 而非 close。
// 3. 选区取词零原生依赖：Windows 用 PowerShell SendKeys 模拟 Ctrl+C，
//    macOS 用 osascript 模拟 Cmd+C，前后做剪贴板备份/还原；Linux 暂不支持。
// 4. 快捷键开关持久化在 app_config，设置页切换后立即重新注册。
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen } from 'electron'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { appConfigRepo } from './db/repositories/app-config.repo'
import { IPC } from '../shared/types'
import type { PopupConfig, PopupPayload, PopupSetConfigResult } from '../shared/types'
import { lockService } from './lock/lock'
import { denyNewWindows } from './net/external-links'

const WIN_W = 440
const WIN_H = 600

const DEFAULT_QUICK_ACCEL = 'CommandOrControl+Shift+Space'
const DEFAULT_SELECT_ACCEL = 'CommandOrControl+Shift+U'
const CFG_QUICK = 'popup.quick_enabled'
const CFG_SELECTION = 'popup.selection_enabled'
const CFG_QUICK_ACCEL = 'popup.quick_accel'
const CFG_SELECT_ACCEL = 'popup.selection_accel'

let popupWin: BrowserWindow | null = null
let lastPayload: PopupPayload | null = null
let grabbing: Promise<unknown> | null = null // 取词串行锁，防连按
// 当前已注册的快捷键（更换/退出时按此清单反注册）
let registeredAccels: string[] = []

// ─── 配置 ─────────────────────────────────────────────────────────

function readEnabled(key: string): boolean {
  return appConfigRepo.get(key) !== '0' // 默认开启
}

function readAccelerator(key: string, fallback: string): string {
  const v = appConfigRepo.get(key)
  // 只做粗校验（含 + 且非空），占用冲突在注册阶段发现
  return v && v.length <= 100 && v.includes('+') ? v : fallback
}

export function getPopupConfig(): PopupConfig {
  return {
    quickEnabled: readEnabled(CFG_QUICK),
    selectionEnabled: readEnabled(CFG_SELECTION),
    quickAccelerator: readAccelerator(CFG_QUICK_ACCEL, DEFAULT_QUICK_ACCEL),
    selectionAccelerator: readAccelerator(CFG_SELECT_ACCEL, DEFAULT_SELECT_ACCEL)
  }
}

/** 按给定配置注册快捷键（内部会先反注册旧的）；返回失败的 accel，全部成功返回 null */
function registerWith(cfg: PopupConfig): string | null {
  for (const a of registeredAccels) globalShortcut.unregister(a)
  registeredAccels = []

  if (cfg.quickEnabled) {
    const ok = globalShortcut.register(cfg.quickAccelerator, () => openPopup('quick'))
    if (!ok) {
      console.warn('[popup] 快捷问答快捷键注册失败（可能被其他程序占用）:', cfg.quickAccelerator)
      return cfg.quickAccelerator
    }
    registeredAccels.push(cfg.quickAccelerator)
  }
  if (cfg.selectionEnabled) {
    const ok = globalShortcut.register(cfg.selectionAccelerator, () => {
      // 取词是异步的，串行化避免连按导致剪贴板错乱
      if (grabbing) return
      grabbing = grabSelectedText()
        .then((text) => openPopup(text ? 'selection' : 'quick', text || undefined))
        .catch(() => openPopup('quick'))
        .finally(() => {
          grabbing = null
        })
    })
    if (!ok) {
      console.warn('[popup] 选区助手快捷键注册失败（可能被其他程序占用）:', cfg.selectionAccelerator)
      // 失败时保留已成功注册的另一个
      return cfg.selectionAccelerator
    }
    registeredAccels.push(cfg.selectionAccelerator)
  }
  return null
}

function registerShortcuts(): void {
  registerWith(getPopupConfig())
}

// ─── 选区取词（模拟复制 → 读剪贴板 → 还原） ─────────────────────────

function runCmd(file: string, args: string[], timeout = 2500): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const p = execFile(file, args, { timeout, windowsHide: true }, (err) => {
        if (err) reject(err)
        else resolve()
      })
      p.on('error', reject)
    } catch (e) {
      reject(e as Error)
    }
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function sendCopyHotkey(): Promise<void> {
  if (process.platform === 'win32') {
    // powershell.exe 默认 STA，SendKeys 可用；启动+执行约 200~400ms
    await runCmd(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 60; [System.Windows.Forms.SendKeys]::SendWait('^c'); Start-Sleep -Milliseconds 120"
      ],
      3000
    )
  } else if (process.platform === 'darwin') {
    // 需要"辅助功能"权限；无权限时静默失败
    await runCmd('/usr/bin/osascript', [
      '-e', 'tell application "System Events" to keystroke "c" using command down'
    ])
    await sleep(150)
  }
  // Linux：无零依赖的统一取词方案（xdotool/xclip 不一定存在），v1 不支持
}

async function grabSelectedText(): Promise<string> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return ''

  // 1) 备份当前剪贴板（文本或图片）
  const formats = clipboard.availableFormats()
  const hadText = formats.includes('text/plain')
  const backupText = hadText ? clipboard.readText() : ''
  const backupImage =
    !hadText && formats.includes('image/png') ? clipboard.readImage() : null

  // 2) 向当前前台窗口发送复制快捷键，再读剪贴板
  try {
    await sendCopyHotkey()
  } catch (e) {
    console.warn('[popup] 模拟复制失败:', (e as Error).message)
    return ''
  }
  const text = clipboard.readText().trim()

  // 3) 剪贴板确实被选区内容替换 → 稍后还原用户原剪贴板
  if (text && text !== backupText.trim()) {
    setTimeout(() => {
      try {
        if (hadText) clipboard.writeText(backupText)
        else if (backupImage && !backupImage.isEmpty()) clipboard.writeImage(backupImage)
      } catch {
        // 还原失败不影响主流程
      }
    }, 250)
  }
  // 选区文本长度保护（防止误抓到整页文本灌爆浮窗）
  return text.slice(0, 8000)
}

// ─── 浮窗窗口（单例幂等） ───────────────────────────────────────────

function positionFor(mode: 'quick' | 'selection') {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const wa = display.workArea
  const w = Math.min(WIN_W, wa.width - 16)
  const h = Math.min(WIN_H, wa.height - 16)
  let x: number
  let y: number
  if (mode === 'selection') {
    // 贴近鼠标右下方
    x = cursor.x + 12
    y = cursor.y + 24
  } else {
    // 所在屏幕居中
    x = wa.x + Math.round((wa.width - w) / 2)
    y = wa.y + Math.round((wa.height - h) * 0.38)
  }
  // 夹取到工作区内
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8))
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - h - 8))
  return { x, y, width: w, height: h }
}

function createPopupWindow(payload: PopupPayload): BrowserWindow {
  const win = new BrowserWindow({
    ...positionFor(payload.mode as PopupPayload['mode']),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'PocketAI Popup',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')

  // 浮窗渲染助手回复（含 markdown 链接），外链必须收口：拒开应用内新窗
  denyNewWindows(win.webContents)

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/popup')
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/popup' })
  }

  win.webContents.once('did-finish-load', () => {
    win.webContents.send(IPC.POPUP_PAYLOAD_EVENT, lastPayload)
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // 失焦自动隐藏（Spotlight 式）；流式回复在主进程继续，隐藏不中断
  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) win.hide()
  })
  win.on('closed', () => {
    popupWin = null
  })
  return win
}

/** 唯一入口：幂等打开/聚焦浮窗；锁屏状态下拒绝唤起，返回 null */
export function openPopup(mode: 'quick' | 'selection', text?: string): BrowserWindow | null {
  // 浮窗会展示会话/选区文本，锁屏时唤起会绕过主窗口锁屏遮罩
  if (lockService.getStatus().state === 'locked') return null
  lastPayload = { mode, text, ts: Date.now() }
  if (popupWin && !popupWin.isDestroyed()) {
    popupWin.setBounds(positionFor(mode))
    if (!popupWin.isVisible()) popupWin.show()
    popupWin.focus()
    // 已加载完成则立即推送；未完成时 did-finish-load 会推 lastPayload
    if (popupWin.webContents.isLoadingMainFrame() === false) {
      popupWin.webContents.send(IPC.POPUP_PAYLOAD_EVENT, lastPayload)
    }
    return popupWin
  }
  popupWin = createPopupWindow(lastPayload)
  return popupWin
}

function hidePopup(): void {
  if (popupWin && !popupWin.isDestroyed()) popupWin.hide()
}

// ─── 初始化（boot 阶段 DB/IPC 就绪后调用一次） ──────────────────────

export function initPopup(): void {
  // 锁屏时自动隐藏已打开的浮窗（浮窗内容属于敏感上下文）
  lockService.onStateChange((evt) => {
    if (evt.state === 'locked') hidePopup()
  })

  ipcMain.handle(IPC.POPUP_HIDE, () => {
    hidePopup()
    return { ok: true }
  })
  ipcMain.handle(IPC.POPUP_GET_PAYLOAD, () => lastPayload)
  ipcMain.handle(IPC.POPUP_GET_CONFIG, () => getPopupConfig())
  ipcMain.handle(
    IPC.POPUP_SET_CONFIG,
    (_e, patch: Partial<PopupConfig>): PopupSetConfigResult => {
      const current = getPopupConfig()
      const nextQuick =
        typeof patch.quickAccelerator === 'string'
          ? patch.quickAccelerator.trim()
          : current.quickAccelerator
      const nextSelect =
        typeof patch.selectionAccelerator === 'string'
          ? patch.selectionAccelerator.trim()
          : current.selectionAccelerator
      const next: PopupConfig = {
        quickEnabled:
          typeof patch.quickEnabled === 'boolean' ? patch.quickEnabled : current.quickEnabled,
        selectionEnabled:
          typeof patch.selectionEnabled === 'boolean'
            ? patch.selectionEnabled
            : current.selectionEnabled,
        quickAccelerator: nextQuick,
        selectionAccelerator: nextSelect
      }

      // 两个快捷键不能相同（都启用时才会真正冲突）
      if (
        next.quickEnabled &&
        next.selectionEnabled &&
        nextQuick &&
        nextQuick === nextSelect
      ) {
        return { ok: false, error: 'same', config: current }
      }

      // 先按新配置试注册：成功才落库；失败则用旧配置恢复，原快捷键不受影响
      const failedAccel = registerWith(next)
      if (failedAccel) {
        registerShortcuts() // 恢复旧注册
        return { ok: false, error: 'occupied', accel: failedAccel, config: current }
      }

      // 试注册通过 → 持久化（已注册的快捷键继续保留，无需再注册一次）
      appConfigRepo.set(CFG_QUICK, next.quickEnabled ? '1' : '0')
      appConfigRepo.set(CFG_SELECTION, next.selectionEnabled ? '1' : '0')
      appConfigRepo.set(CFG_QUICK_ACCEL, nextQuick)
      appConfigRepo.set(CFG_SELECT_ACCEL, nextSelect)
      return { ok: true, config: getPopupConfig() }
    }
  )

  // app ready 后才能注册全局快捷键
  if (app.isReady()) registerShortcuts()
  else app.whenReady().then(registerShortcuts)
  app.on('will-quit', () => {
    for (const a of registeredAccels) globalShortcut.unregister(a)
    registeredAccels = []
  })
}
