import { app, ipcMain, webContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import EventEmitter from 'node:events'
import { IPC, type UpdateStatus } from '../shared/types'
import { acquireKeepAwake, releaseKeepAwake } from './keep-awake'
import { appConfigRepo } from './db/repositories/app-config.repo'
import { downloadAsarPatch, restartToApplyPatch, isPatchPending } from './update/asar-patcher'
import { isPortableRuntime } from './portable'
import { safeFetch } from './net/safe-fetch'

// ─── 单例 UpdateManager ──────────────────────────────────────────
// 负责封装 electron-updater，维护状态机 + 互斥锁
// 事件通过 IPC.UPDATE_EVENT 通道推送到渲染进程

class UpdateManager extends EventEmitter {
  private status: UpdateStatus = 'idle'
  private newVersion?: string
  private progress = 0
  private totalBytes = 0
  private downloadedBytes = 0
  private error?: string
  /** 互斥锁：任何时刻只能一个流程在跑 */
  private busy = false
  /** 自动更新开关（持久化于 app_config，默认关闭） */
  private autoUpdateEnabled = false

  // ── 初始化（主进程启动时调用一次）────────────────────────────────
  init(): void {
    // 读取开关并应用（默认关闭：不自动检查、不自动下载）
    this.autoUpdateEnabled = appConfigRepo.isAutoUpdateEnabled()
    this.applyAutoUpdateFlags()

    // 开发环境：不注册 electron-updater（会报错）
    if (!app.isPackaged) {
      // 仍然设置状态监听的 fallback，让 UI 能正常展示
      this.setStatus('unavailable', { error: '开发环境不支持自动更新' })
      return
    }

    // 开启自动更新：启动后延迟检查一次（自动下载由 autoDownload 标志接管）
    if (this.autoUpdateEnabled) {
      setTimeout(() => {
        this.check().catch(() => {})
      }, 5000)
    }

    // ── 注册事件 ──
    autoUpdater.on('checking-for-update', () => {
      this.setStatus('checking')
    })

    autoUpdater.on('update-available', (info) => {
      this.newVersion = info.version
      this.setStatus('available', { newVersion: info.version })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.newVersion = info.version
      this.setStatus('unavailable', { newVersion: info.version })
    })

    autoUpdater.on('download-progress', (info) => {
      this.progress = Math.round(info.percent)
      this.totalBytes = info.total
      this.downloadedBytes = info.transferred
      this.setStatus('downloading', {
        progress: this.progress,
        totalBytes: this.totalBytes,
        downloadedBytes: this.downloadedBytes
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.newVersion = info.version
      this.progress = 100
      this.setStatus('downloaded', { newVersion: info.version })
    })

    autoUpdater.on('error', (err) => {
      this.error = err.message
      this.setStatus('error', { error: err.message })
    })
  }

  // ── 推送状态到所有渲染窗口 ──────────────────────────────────────
  private setStatus(status: UpdateStatus, extra: Record<string, any> = {}): void {
    this.status = status
    this.emit('status', { status, ...extra })
    // 推送到所有 webContents
    try {
      for (const wc of webContents.getAllWebContents()) {
        wc.send(IPC.UPDATE_EVENT, { status, ...extra })
      }
    } catch { /* 某些时刻没有 webContents */ }
    // busy 锁：error / downloaded / unavailable / idle / available 释放
    if (['error', 'downloaded', 'unavailable', 'idle', 'available'].includes(status)) {
      this.busy = false
    }
  }

  // ── 查询当前状态（IPC 直接返回，不用事件）───────────────────────
  getStatusSnapshot(): Record<string, any> {
    return {
      status: this.status,
      newVersion: this.newVersion,
      progress: this.progress,
      error: this.error
    }
  }

  // ── 应用自动更新标志 ─────────────────────────────────────────────
  private applyAutoUpdateFlags(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = this.autoUpdateEnabled // 开=自动下载；关=用户点了才下载
    autoUpdater.autoInstallOnAppQuit = true
  }

  // ── 获取环境信息 ────────────────────────────────────────────────
  getInfo() {
    return {
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      isPortable: app.isPackaged && isPortableRuntime(),
      autoUpdateEnabled: this.autoUpdateEnabled
    }
  }

  // ── 设置自动更新开关（持久化 + 立即生效）────────────────────────
  async setAutoUpdate(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    this.autoUpdateEnabled = !!enabled
    try {
      appConfigRepo.setAutoUpdateEnabled(this.autoUpdateEnabled)
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) }
    }
    this.applyAutoUpdateFlags()

    // 开启时立即检查一次（仅打包环境）；关闭时不打断进行中的流程
    if (this.autoUpdateEnabled && app.isPackaged && !this.busy) {
      this.check().catch(() => {})
    }
    return { ok: true }
  }

  // ── 检查更新 ────────────────────────────────────────────────────
  async check(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '正在进行中的更新流程' }

    if (!app.isPackaged) {
      // dev 环境：mock 一个"不可用"，让 UI 能正常展示
      this.setStatus('unavailable', { error: '开发环境不支持自动更新（打包后可用）' })
      return { ok: true }
    }

    // Linux：仅 AppImage 形态支持自动更新（electron-updater 的 AppImageUpdater 依赖 APPIMAGE env）
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      this.setStatus('unavailable', { error: '当前 Linux 运行形态不支持自动更新，请手动下载最新 AppImage' })
      return { ok: true }
    }

    // Windows Portable：electron-builder 不生成 app-update.yml，无法自动更新
    if (process.platform === 'win32' && isPortableRuntime()) {
      this.setStatus('unavailable', { error: '便携版不支持自动更新，请手动下载新版替换' })
      return { ok: true }
    }

    this.busy = true
    this.error = undefined
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.setStatus('error', { error: this.error })
      return { ok: false, error: this.error }
    }
  }

  // ── 下载更新 ────────────────────────────────────────────────────
  async download(): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) return { ok: false, error: '正在进行中的更新流程' }
    if (this.status !== 'available') {
      return { ok: false, error: `当前状态 ${this.status}，需要先检查更新` }
    }

    if (!app.isPackaged) {
      return { ok: false, error: '开发环境不支持下载' }
    }

    this.busy = true
    this.error = undefined
    acquireKeepAwake() // 下载期间阻止系统睡眠（后台保活）
    try {
      // ── 增量优先（仅 Windows 安装版；便携版/AppImage 跳过）──
      // 任何一步失败（补丁不存在/校验失败/网络错误）静默回退全量更新
      if (!isPortableRuntime()) {
        try {
          const patch = await downloadAsarPatch(this.newVersion ?? '')
          if (patch.ok) {
            this.progress = 100
            this.downloadedBytes = patch.patchBytes
            this.totalBytes = patch.newSize
            this.setStatus('downloaded', { newVersion: this.newVersion })
            return { ok: true }
          }
        } catch {
          // 回退全量（electron-updater）
        }
      }

      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.setStatus('error', { error: this.error })
      return { ok: false, error: this.error }
    } finally {
      releaseKeepAwake()
    }
  }

  // ── 退出并安装 ──────────────────────────────────────────────────
  async quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
    if (this.status !== 'downloaded') {
      return { ok: false, error: `当前状态 ${this.status}，需要先下载完成` }
    }
    if (!app.isPackaged) {
      return { ok: false, error: '开发环境不支持安装' }
    }

    // 增量补丁就绪 → 延迟替换脚本 + 重启（不走 NSIS 安装器）
    if (isPatchPending()) {
      try {
        restartToApplyPatch() // 内部 app.quit()
        return { ok: true }
      } catch (e: any) {
        this.error = e?.message ?? String(e)
        this.setStatus('error', { error: this.error })
        return { ok: false, error: this.error }
      }
    }

    try {
      // silent: true = 静默安装（不用 NSIS 界面）
      autoUpdater.quitAndInstall(true, true)
      return { ok: true }
    } catch (e: any) {
      this.error = e?.message ?? String(e)
      this.setStatus('error', { error: this.error })
      return { ok: false, error: this.error }
    }
  }
}

export const updateManager = new UpdateManager()

// ── 初始化入口（在 boot 中调用）──────────────────────────────────
export function initUpdateManager(): void {
  updateManager.init()

  // 注册 IPC handlers
  ipcMain.handle(IPC.UPDATE_GET_INFO, () => updateManager.getInfo())
  ipcMain.handle(IPC.UPDATE_CHECK, () => updateManager.check())
  ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => updateManager.download())
  ipcMain.handle(IPC.UPDATE_QUIT_INSTALL, () => updateManager.quitAndInstall())
  ipcMain.handle(IPC.UPDATE_SET_SETTINGS, (_e, enabled: boolean) =>
    updateManager.setAutoUpdate(!!enabled)
  )

  // 状态快照（渲染首次连接时调一下）
  ipcMain.handle('update:get-status', () => updateManager.getStatusSnapshot())

  // 更新日志：从 GitHub Releases API 拉取
  ipcMain.handle(IPC.CHANGELOG_FETCH, async () => {
    try {
      const url = 'https://api.github.com/repos/yyygzy/PocketAI/releases?per_page=10'
      const res = await safeFetch(url, {
        timeoutMs: 12000,
        maxBytes: 2 * 1024 * 1024,
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (res.status !== 200) {
        return { ok: false, error: `GitHub API HTTP ${res.status}` }
      }
      const data = JSON.parse(res.body.toString())
      if (!Array.isArray(data)) {
        return { ok: false, error: 'GitHub API 返回格式异常' }
      }
      const releases = data
        .filter((r: any) => !r.draft)
        .map((r: any) => ({
          tag: String(r.tag_name ?? ''),
          name: String(r.name ?? ''),
          date: String(r.published_at ?? ''),
          body: String(r.body ?? ''),
          url: String(r.html_url ?? ''),
          prerelease: !!r.prerelease,
        }))
      return { ok: true, releases }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? '拉取更新日志失败' }
    }
  })
}
