// 窗口行为设置：开机自启 + 关窗最小化到托盘
//
// - 开机自启走 app.setLoginItemSettings；仅在打包版生效
//   （dev 环境会指向 electron.exe，污染登录项，跳过并返回 applied=false）。
// - 关窗到托盘只读配置；close 钩子在 index.ts 中读取 isCloseToTray()，
//   为真时 hide 主窗口而非退出（托盘「退出墨匣」菜单仍可真退出）。
import { app } from 'electron'
import { appConfigRepo } from './db/repositories/app-config.repo'
import { IPC, type WindowBehaviorSettings } from '../shared/types'
import { safeHandle, argsSchema, z } from './ipc/safe-handle'
import { createLogger } from './logger'

const log = createLogger('window-behavior')

/** 应用开机自启配置到系统；返回是否实际调用了 setLoginItemSettings */
export function applyLaunchAtLogin(): boolean {
  const enabled = appConfigRepo.isLaunchAtLogin()
  if (!app.isPackaged) return false
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return true
  } catch (e) {
    log.warn('setLoginItemSettings failed:', e)
    return false
  }
}

export function setLaunchAtLogin(enabled: boolean): boolean {
  appConfigRepo.setLaunchAtLogin(enabled)
  return applyLaunchAtLogin()
}

export function isCloseToTray(): boolean {
  return appConfigRepo.isCloseToTray()
}

export function getWindowBehaviorSettings(): WindowBehaviorSettings {
  return {
    launchAtLogin: appConfigRepo.isLaunchAtLogin(),
    closeToTray: appConfigRepo.isCloseToTray(),
    launchAtLoginApplied: app.isPackaged
  }
}

/** 注册窗口行为 IPC（boot 阶段调用一次） */
export function registerWindowBehaviorHandlers(): void {
  safeHandle(IPC.WINDOW_BEHAVIOR_GET, () => getWindowBehaviorSettings())
  safeHandle(IPC.WINDOW_BEHAVIOR_SET_LAUNCH, (_e, enabled: boolean) => {
    setLaunchAtLogin(!!enabled)
    return getWindowBehaviorSettings()
  }, argsSchema(z.boolean()))
  safeHandle(IPC.WINDOW_BEHAVIOR_SET_CLOSE_TO_TRAY, (_e, enabled: boolean) => {
    appConfigRepo.setCloseToTray(!!enabled)
    return getWindowBehaviorSettings()
  }, argsSchema(z.boolean()))
}
