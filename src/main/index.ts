// PocketAI 主进程入口
//
// 启动流程（Phase 4 加密版）：
// ┌─────────────────────────────────────────────────────────┐
// │  1. 确保数据目录 + 重定向 Electron userData → data/     │
// │  2. 打开数据库（先无密码打开以读取 app_config）          │
// │  3. runMigrations() 确保 schema 完整                     │
// │  4. 读 app_config.encryption_mode + has_master_password │
// │     ├─ 'none'  → 主密钥管理器初始化无密码模式           │
// │     └─ 'db'    → 关闭 DB → 显示解锁窗口 → 输入密码     │
// │                    → setKey(password, salt)             │
// │                    → dbService.open(masterKey)          │
// │  5. 同步内置助手                                        │
// │  6. 注册 IPC handlers                                   │
// │  7. 验证 License（如果存在 license.lic）                 │
// │  8. 创建主窗口                                          │
// └─────────────────────────────────────────────────────────┘
//
// 为什么"先无密码打开 DB 读配置"？
// - 首次启动：明文库，app_config 表刚被 migration 创建，读 encryption_mode='none'
// - 加密模式：如果 DB 是加密的，无密码 open() 会立即抛 SQLITE_NOTADB，catch 后
//             直接显示解锁窗口（不需要先无密码打开）

import { app, BrowserWindow, dialog, powerMonitor } from 'electron'
import path from 'node:path'
import { ensureDirs, DATA_DIR } from './portable'
import { dbService } from './db/database'
import { registerIpcHandlers, initChannelRuntime } from './ipc'
import { syncBuiltinAssistants, syncBuiltinSkills } from './assistant/builtin'
import { mcpManager } from './mcp/manager'
import { masterKeyManager } from './crypto/master-key'
import { unlockCoordinator } from './crypto/unlock-coordinator'
import { appConfigRepo } from './db/repositories/app-config.repo'
import { getHardwareInfo } from './steward/hardware'
import { licenseService } from './license/license'
import { initUpdateManager } from './update-manager'
import { buildAppMenu } from './menu'
import { initPopup } from './popup'
import { lockService } from './lock/lock'
import { installLockGate } from './lock/ipc-gate'
import { denyNewWindows } from './net/external-links'
import { installContentSecurityPolicy } from './security/csp'
import { initBackupScheduler, stopBackupScheduler } from './backup/backup-scheduler'
import { applyOpacityToMainWindows } from './ui-preferences'

app.setPath('userData', path.join(DATA_DIR, 'userdata'))
app.setPath('sessionData', path.join(DATA_DIR, 'session'))

let mainWindow: BrowserWindow | null = null
let unlockWindow: BrowserWindow | null = null

// ─── DB 打开（先尝试无密码，失败 = 已加密） ────────────────────────

function tryOpenDbNoPassword(): boolean {
  try {
    dbService.open()
    dbService.runMigrations()
    return true
  } catch (e: any) {
    // SQLITE_NOTADB = 文件是加密的，必须用密码打开
    if (e?.code === 'SQLITE_NOTADB' || e?.message?.includes('not a database')) {
      // 关掉无 key 的死连接：dbService.open() 对已开连接幂等返回，
      // 死连接不关掉，后续带 key 重开和 salt 读取都会撞上它
      try { dbService.close() } catch { /* ignore */ }
      return false
    }
    // 其他错误：未知 DB 损坏
    console.error('[db] 打开失败:', e?.message ?? e)
    dialog.showErrorBox('数据库损坏', String(e?.message ?? e))
    process.exit(1)
  }
  return false
}

// ─── 解锁窗口 ─────────────────────────────────────────────────────

function showUnlockWindow(mode: 'unlock' | 'setPassword' = 'unlock'): void {
  if (unlockWindow) {
    unlockWindow.focus()
    return
  }

  unlockWindow = new BrowserWindow({
    width: 420,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    title: 'PocketAI — 解锁',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  unlockWindow.on('ready-to-show', () => unlockWindow?.show())
  // 锁屏窗口同样收口外链
  denyNewWindows(unlockWindow.webContents)

  // 渲染进程加载 unlock.html（独立入口），附带 mode 参数
  const query = `?mode=${mode}`
  if (process.env['ELECTRON_RENDERER_URL']) {
    // dev：Vite 服务器 URL 是 http://localhost:5173/ ，用 URL 替换 pathname
    const base = new URL(process.env['ELECTRON_RENDERER_URL'])
    base.pathname = '/unlock.html'
    base.search = query
    unlockWindow.loadURL(base.toString())
  } else {
    unlockWindow.loadFile(path.join(__dirname, '../renderer/unlock.html'), { query: { mode } })
  }

  // 解锁窗口关闭 = 用户放弃（解锁是强制的，app 退出）
  unlockWindow.on('closed', () => {
    unlockWindow = null
    if (!mainWindow) {
      unlockCoordinator.cancel()
      app.quit()
    }
  })
}

// ─── 主窗口 ───────────────────────────────────────────────────────

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#1e1e2e',
    title: 'PocketAI',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  // 隐私锁：窗口隐藏/最小化 → 计时；重新显示 → 取消计时
  mainWindow.on('hide', () => lockService.onAppHidden())
  mainWindow.on('show', () => lockService.onAppShown())
  mainWindow.on('minimize', () => lockService.onAppHidden())
  mainWindow.on('restore', () => lockService.onAppShown())

  // 外链收口：应用内拒开新窗，仅 http/https 跳系统浏览器（防 file:/javascript: 等）
  denyNewWindows(mainWindow.webContents)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ─── 核心启动流程 ─────────────────────────────────────────────────

async function boot(): Promise<void> {
  ensureDirs()

  // IPC 必须在任何窗口（含解锁窗）创建/加载前就位：
  // 解锁窗挂载即会调用 encryption:unlock / menu:set-language 等通道，
  // 若延后到解锁流程之后注册，这些 invoke 会得到 “No handler registered”。
  // handler 均为惰性闭包，DB 尚未打开时注册也安全。
  installLockGate()
  registerIpcHandlers()

  // 阶段 1：尝试无密码打开 DB
  const openedPlaintext = tryOpenDbNoPassword()

  let needUnlock = false
  let hasExistingPassword = false

  if (openedPlaintext) {
    // 读配置判断是否需要主密码
    const mode = appConfigRepo.getEncryptionMode()
    hasExistingPassword = appConfigRepo.hasMasterPassword()

    if (mode === 'db' || hasExistingPassword) {
      // 配置里写了需要密码，但我们是无密码打开的 → 这说明：
      // 1. 用户设置过密码但 DB 实际没加密（异常状态），或
      // 2. 用户取消密码后 app_config 没清理干净
      // 保守处理：要求用户重新设置密码，先让 DB 以无密码模式打开
      console.warn('[boot] app_config 标记需要密码，但 DB 实际可无密码打开 → 进入解锁/重设流程')
      needUnlock = true
    } else {
      // 纯无密码模式
      masterKeyManager.init('none')
    }
  } else {
    // DB 是加密的，必须解锁
    masterKeyManager.init('db') // 先标记模式：锁屏 UI 与状态查询在解锁前就要依赖它
    needUnlock = true
    hasExistingPassword = true
  }

  // 阶段 2：如需要密码 → 显示解锁窗口
  if (needUnlock) {
    // 如果 DB 已经被无密码打开过（上面的 tryOpenDbNoPassword），要先关闭再以密码重开
    if (dbService.getEncryptionMode() === 'none' && !hasExistingPassword) {
      // 无密码打开成功 → 说明 DB 实际是明文，让用户设置新密码
      console.log('[boot] 明文 DB，显示"设置主密码"流程')
    }

    const unlockMode: 'unlock' | 'setPassword' =
      dbService.getEncryptionMode() === 'none' && !hasExistingPassword ? 'setPassword' : 'unlock'
    showUnlockWindow(unlockMode)
    const result = await unlockCoordinator.waitForUnlock()

    if (!result) {
      // 用户关闭了解锁窗口，不继续启动
      return
    }

    if ('password' in result) {
      // 解锁（验证已有密码）
      const salt = appConfigRepo.getMasterPasswordSalt()
      const masterKey = masterKeyManager.setKey(result.password, salt ?? undefined)

      // 如果是加密 DB（之前没打开过），现在用密码打开
      if (!openedPlaintext) {
        dbService.open(masterKey)
        dbService.runMigrations()
      } else {
        // DB 已无密码打开，现在重新打开为加密模式
        dbService.close()
        dbService.open(masterKey)
      }

      // 验证密码正确：跑一条简单 SQL
      try {
        dbService.getHandle().prepare('SELECT 1').get()
        console.log('[boot] DB 解锁成功')
      } catch (e) {
        console.error('[boot] 密码错误或 DB 损坏:', e)
        dialog.showErrorBox('解锁失败', '密码错误或数据库已损坏')
        app.quit()
        return
      }
    } else if ('setPassword' in result) {
      // 设置新密码（明文 DB 首次加密）
      const newPwd = result.setPassword
      const salt = masterKeyManager.generateSalt()
      appConfigRepo.setMasterPasswordSalt(salt)

      if (!openedPlaintext) {
        // 不应该走到这里（如果 DB 是加密的，用户应该走解锁流程）
        console.error('[boot] 加密 DB 收到设置密码请求 → 拒绝')
        app.quit()
        return
      }

      // 明文 DB → enableEncryption
      const masterKey = masterKeyManager.setKey(newPwd, salt)
      dbService.enableEncryption(masterKey)
      appConfigRepo.setEncryptionMode('db')
      appConfigRepo.setHasMasterPassword(true)
      console.log('[boot] DB 已加密')
    }

    unlockWindow?.close()
    unlockWindow = null
  }

  // 阶段 3：同步助手 + 技能 + 注册 IPC
  const synced = syncBuiltinAssistants()
  console.log(
    `[assistants] 内置助手同步完成: ${synced.count} 个` +
      (synced.errors.length ? `，错误: ${synced.errors.join('; ')}` : '')
  )
  const syncedSkills = syncBuiltinSkills()
  console.log(
    `[skills] 内置技能同步完成: ${syncedSkills.count} 个` +
      (syncedSkills.errors.length ? `，错误: ${syncedSkills.errors.join('; ')}` : '')
  )

  // 快捷浮窗（快捷问答 / 选区助手）：全局快捷键 + IPC
  // （IPC 网关于 boot 开头安装，此处 initPopup 注册的通道同样受其保护）
  initPopup()

  // Channels 网关运行时接线（需读 app_config，必须在 DB 打开之后）
  initChannelRuntime()

  // 阶段 4：License 验证（仅当存在 license.lic 时）
  try {
    const licPath = appConfigRepo.getLicensePath()
    if (licPath) {
      licenseService.loadFromFile(licPath)
      console.log('[license] 已加载:', licPath)
    } else {
      // 尝试默认路径
      const defaultLic = path.join(DATA_DIR, 'license.lic')
      const fs = require('node:fs')
      if (fs.existsSync(defaultLic)) {
        licenseService.loadFromFile(defaultLic)
        appConfigRepo.setLicensePath(defaultLic)
        console.log('[license] 已加载默认 license.lic')
      }
    }
  } catch (e) {
    console.warn('[license] 加载失败:', String(e))
  }

  // 阶段 5：创建主窗口
  createMainWindow()
  // 应用已保存的窗口透明度
  applyOpacityToMainWindows()

  // 阶段 6：自动更新（必须在主窗口创建后，因为 setStatus 里有 webContents.send）
  initUpdateManager()

  // 阶段 7：隐私锁
  // db 模式锁定 → 清除主进程密钥并关闭数据库（兑现 lock.ts 设计承诺；
  // 解锁走 LOCK_UNLOCK 的「重开探针」重新验证主密码）。none 模式仅锁 UI：
  // 明文库无秘密可保护，且定时备份依赖字段密钥继续工作。
  lockService.onStateChange((evt) => {
    if (evt.state !== 'locked') return
    if (masterKeyManager.getMode() !== 'db') return
    masterKeyManager.clear()
    dbService.close()
  })
  lockService.init()
  // 定时 WebDAV 备份调度器（内部自行判断开关/锁屏状态）
  initBackupScheduler()
  powerMonitor.on('suspend', () => lockService.onOsSleep())
  powerMonitor.on('resume', () => lockService.onOsWake())
  powerMonitor.on('lock-screen', () => lockService.lock('os-sleep'))
  powerMonitor.on('unlock-screen', () => { /* 保持锁定，等用户在应用内解锁 */ })
}

// ─── 单实例锁 ───────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    // 生产环境 CSP 必须在任何窗口创建前安装（解锁窗在 boot() 内创建）
    installContentSecurityPolicy()
    // 默认中文菜单；渲染进程加载后会上报实际语言并重建
    buildAppMenu('zh')
    // 硬件画像在启动时后台采集一次（结果缓存在主进程），
    // 之后管家页面只读快照；需要时由用户点「重新检测」手动刷新。
    // 延后到启动流程之后执行，避免系统命令采集拖慢开窗。
    setImmediate(() => {
      try {
        getHardwareInfo()
      } catch (err) {
        console.warn('[boot] 启动硬件检测失败:', err)
      }
    })
    boot().catch((err) => {
      console.error('[boot] 启动失败:', err)
      dialog.showErrorBox('启动失败', String(err))
      app.quit()
    })
  })
}

app.on('window-all-closed', () => {
  try { dbService.close() } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  try { mcpManager.stopAll().catch(() => {}) } catch { /* ignore */ }
  try { stopBackupScheduler() } catch { /* ignore */ }
  try { dbService.close() } catch { /* ignore */ }
})
