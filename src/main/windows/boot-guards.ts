// 启动期窗口（解锁窗、主窗口）的图标 / 加载重试 / 显示兜底。
//
// 这两个窗口都是 show:false 创建、等渲染层首帧（ready-to-show）再显示。问题在于
// ready-to-show 只在渲染进程真的画出首帧时才发：一旦导航根本没开始，它永远不会来。
// 2026-11-08 的真机事故就是这个形态——网络服务在 loadURL 当口崩溃，did-start-loading
// 与 did-fail-load 一个都没来，而旧实现的计时器只挂在 did-start-loading 上，于是永久
// 静默：窗口不可见、日志一字不增、用户面前一片空白。下面两道兜底都不依赖渲染事件。

import { app, dialog, BrowserWindow } from 'electron'
import path from 'node:path'
import { createLogger } from '../logger'

const log = createLogger('boot')

// dev 判定：不能只看 app.isPackaged。本机 `electron .` 启动时 app.isPackaged 实测仍为
// true（2026-11-03 dev 白屏排查），单靠它会让 dev 加固开关与下面的超时判据一起失效；
// electron-vite dev 必定注入 ELECTRON_RENDERER_URL，用它兜住。
export const IS_DEV_MODE = !app.isPackaged || process.env.ELECTRON_RENDERER_URL !== undefined

/** 应用图标：Windows 用 .ico（含 16/32/48/256 多尺寸，任务栏显示更清晰），其他平台用 256px png */
export function appIconPath(): string {
  return process.platform === 'win32'
    ? path.join(app.getAppPath(), 'build/icon/icon.ico')
    : path.join(app.getAppPath(), 'build/icon/icon-256.png')
}

/**
 * 页面加载失败/挂起自动重试。
 *
 * 三重兜底：
 * ① did-fail-load（请求被丢/连接被拒）→ 重新发起导航；
 * ② 导航开始后超时无响应（网络服务崩溃恢复期内请求既不成功也不失败）→ 重新发起导航；
 * ③ **导航从未开始**——安装即武装计时器（不等 did-start-loading），另有 5s 快探针：
 *    5s 内连 did-start-navigation 与已提交 URL 都没有，就立刻重发。网络服务在 loadURL
 *    当口崩溃时实测①②的事件一个都不会来，只靠它们会永久静默。
 *
 * 重发导航用调用方传入的 `reload` 而不是 webContents.reload()：导航没提交时"当前页"
 * 还是 about:blank，reload() 只会重载那一页空白。
 *
 * 挂起阈值：打包版 8s；dev 30s——Vite 首次按需编译渲染端模块图实测 17.6s
 * （2026-11-03 dev 白屏排查），8s 会把正常冷启动误判成挂起。
 */
export function installLoadRetry(win: BrowserWindow, label: string, reload: () => void): void {
  let retries = 0
  let hangTimer: NodeJS.Timeout | null = null
  let startProbe: NodeJS.Timeout | null = null
  let warned = false
  const hangMs = IS_DEV_MODE ? 30_000 : 8_000
  // 快探针：正常导航在毫秒级就会发出 did-start-navigation；5s 内连这个事件都没有，
  // 就是「请求根本没被派发」（网络服务崩溃后实测的形态），不必等 30s 挂起阈值。
  const navStartProbeMs = 5_000

  function clearTimers(): void {
    if (hangTimer) {
      clearTimeout(hangTimer)
      hangTimer = null
    }
    if (startProbe) {
      clearTimeout(startProbe)
      startProbe = null
    }
  }

  /** 导航是否已经提交出内容（did-start-navigation 没来也能靠它兜住） */
  function navigationStarted(): boolean {
    if (win.isDestroyed()) return true
    const url = win.webContents.getURL()
    return url !== '' && url !== 'about:blank'
  }

  /**
   * 武装两个计时器：① 5s 快探针＝导航压根没开始；② hangMs 挂起阈值＝导航开始了但没收到
   * did-stop-loading（网络服务恢复期内请求既不成功也不失败）。
   * 注意②不能因 isLoading()===false 静默返回——「请求没被派发」恰好也是 false。
   */
  function armHangTimer(): void {
    clearTimers()
    startProbe = setTimeout(() => {
      startProbe = null
      if (win.isDestroyed() || navigationStarted()) return
      retry(`导航 ${navStartProbeMs / 1000}s 内未开始（请求未被派发）`)
    }, navStartProbeMs)
    hangTimer = setTimeout(() => {
      hangTimer = null
      if (win.isDestroyed()) return
      retry(`页面加载超时(${hangMs / 1000}s 无响应)`)
    }, hangMs)
  }

  function retry(why: string): void {
    if (win.isDestroyed()) return
    if (retries >= 5) {
      log.error(`${label} 页面加载失败（已重试 ${retries} 次）: ${why}`)
      // 重试穷尽仍未加载成功 → 大概率安全软件（杀软/电脑管家类）查杀
      // 网络服务进程。生产环境没有终端可看日志，弹窗引导用户自救。
      if (!warned) {
        warned = true
        try {
          dialog.showMessageBox({
            type: 'warning',
            title: '页面加载失败',
            message: `${label}页面多次加载失败，界面可能一直空白。`,
            detail:
              '常见原因：安全软件（电脑管家/杀毒软件）拦截了应用的网络组件。\n' +
              '请在安全软件中把本应用所在目录加入「信任区/白名单」后重新打开应用。\n' +
              `应用目录：${app.getAppPath()}`
          })
        } catch { /* dialog 不可用时忽略 */ }
      }
      return
    }
    retries++
    log.warn(`${label} ${why}，${retries}/5 次重试…`)
    reload()
    // 重发导航在 webContents 卡死时可能不产生新导航（不触发 did-start-loading），
    // 这里补一次计时，避免重试链断在 1/5 后窗口长期空白
    armHangTimer()
  }

  win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    retry(`加载失败(${code} ${desc})`)
  })

  win.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    // 导航已开始：快探针失业，挂起阈值继续盯 did-stop-loading
    if (startProbe) {
      clearTimeout(startProbe)
      startProbe = null
    }
  })

  win.webContents.on('did-start-loading', () => {
    armHangTimer()
  })

  win.webContents.on('did-stop-loading', () => {
    clearTimers()
  })

  // 崩溃取证：渲染进程没了就永远不会有 ready-to-show，窗口会一直停在隐藏态
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`${label} 渲染进程退出: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  // 关键：安装即武装（两个调用点都在 loadURL 之前调用本函数）。第③条兜底全靠这一行。
  armHangTimer()
}

/**
 * 显示兜底：ready-to-show 是唯一的显示入口，而它只在渲染进程真出首帧时才发。
 * 若导航从未开始（见 installLoadRetry 的第③条），这个事件永远不会来，窗口就永远停在
 * show:false——日志说"已弹出"、屏幕上什么都没有。这里用一个与渲染事件无关的计时器兜底。
 *
 * 时长必须晚于加载重试的一整轮（dev 30s / 打包 8s），否则正常冷启动（Vite 首次编译
 * 17.6s）也会被兜底抢占，先弹出一个还没有内容的空窗口。
 */
export function installShowFallback(win: BrowserWindow, label: string): void {
  const delayMs = IS_DEV_MODE ? 45_000 : 12_000
  const timer = setTimeout(() => {
    if (win.isDestroyed() || win.isVisible()) return
    log.warn(
      `${label} ${delayMs / 1000}s 内未触发 ready-to-show（渲染层未出首帧），兜底强制显示；` +
        `url=${win.webContents.getURL() || '(空)'} loading=${win.webContents.isLoading()}`
    )
    win.show()
    win.focus()
  }, delayMs)
  win.once('show', () => clearTimeout(timer))
  win.once('closed', () => clearTimeout(timer))
}
