// 覆盖 src/main/window-behavior.ts：
// - applyLaunchAtLogin：dev（isPackaged=false）跳过不调用 setLoginItemSettings；
//   打包版按配置 true/false 调用
// - setLaunchAtLogin：写库 + 立即应用
// - isCloseToTray / getWindowBehaviorSettings：配置读取与返回结构
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  packaged: false,
  loginCalls: [] as Array<{ openAtLogin: boolean }>,
  store: new Map<string, string>()
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocks.packaged },
    setLoginItemSettings: (s: { openAtLogin: boolean }) => { mocks.loginCalls.push(s) }
  },
  ipcMain: { handle: () => {} }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    isLaunchAtLogin: () => mocks.store.get('launch_at_login') === '1',
    setLaunchAtLogin: (v: boolean) => mocks.store.set('launch_at_login', v ? '1' : '0'),
    isCloseToTray: () => mocks.store.get('close_to_tray') === '1',
    setCloseToTray: (v: boolean) => mocks.store.set('close_to_tray', v ? '1' : '0')
  }
}))

import {
  applyLaunchAtLogin,
  setLaunchAtLogin,
  isCloseToTray,
  getWindowBehaviorSettings
} from '../src/main/window-behavior'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'

beforeEach(() => {
  mocks.packaged = false
  mocks.loginCalls.length = 0
  mocks.store.clear()
})

describe('applyLaunchAtLogin', () => {
  it('dev 环境跳过：返回 false 且不调用 setLoginItemSettings', () => {
    appConfigRepo.setLaunchAtLogin(true)
    expect(applyLaunchAtLogin()).toBe(false)
    expect(mocks.loginCalls).toHaveLength(0)
  })
  it('打包版按配置开启调用系统 API', () => {
    mocks.packaged = true
    appConfigRepo.setLaunchAtLogin(true)
    expect(applyLaunchAtLogin()).toBe(true)
    expect(mocks.loginCalls).toEqual([{ openAtLogin: true }])
  })
  it('打包版配置关闭时也要调用（清除旧登录项）', () => {
    mocks.packaged = true
    expect(applyLaunchAtLogin()).toBe(true)
    expect(mocks.loginCalls).toEqual([{ openAtLogin: false }])
  })
})

describe('setLaunchAtLogin', () => {
  it('写库后立即应用（打包版）', () => {
    mocks.packaged = true
    setLaunchAtLogin(true)
    expect(appConfigRepo.isLaunchAtLogin()).toBe(true)
    expect(mocks.loginCalls).toEqual([{ openAtLogin: true }])
    setLaunchAtLogin(false)
    expect(appConfigRepo.isLaunchAtLogin()).toBe(false)
    expect(mocks.loginCalls[1]).toEqual({ openAtLogin: false })
  })
})

describe('isCloseToTray / getWindowBehaviorSettings', () => {
  it('isCloseToTray 缺省 false，写入后 true', () => {
    expect(isCloseToTray()).toBe(false)
    appConfigRepo.setCloseToTray(true)
    expect(isCloseToTray()).toBe(true)
  })
  it('getWindowBehaviorSettings 结构正确，launchAtLoginApplied 跟随 isPackaged', () => {
    appConfigRepo.setLaunchAtLogin(true)
    appConfigRepo.setCloseToTray(true)
    expect(getWindowBehaviorSettings()).toEqual({
      launchAtLogin: true, closeToTray: true, launchAtLoginApplied: false
    })
    mocks.packaged = true
    expect(getWindowBehaviorSettings().launchAtLoginApplied).toBe(true)
  })
})
