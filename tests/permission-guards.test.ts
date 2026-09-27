// Chromium 权限收口测试（批次 P6-1）
//
// 覆盖 src/main/security/permissions.ts：
//  - isPermissionAllowed 纯函数：默认拒绝，任何权限/来源 URL 均不通过
//  - setPermissionRequestHandler 注册的 handler：一切权限 callback(false)
//  - setPermissionCheckHandler 注册的 handler：一切检查返回 false
//
// 策略：mock electron defaultSession 捕获注册的两个 handler 后手动调用。
import { describe, it, expect, vi } from 'vitest'

const { refs } = vi.hoisted(() => {
  type ReqHandler = (
    wc: unknown,
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl?: string }
  ) => void
  type CheckHandler = (wc: unknown, permission: string) => boolean
  return {
    refs: {
      request: null as ReqHandler | null,
      check: null as CheckHandler | null
    }
  }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setPermissionRequestHandler: (fn: typeof refs.request) => {
        refs.request = fn
      },
      setPermissionCheckHandler: (fn: typeof refs.check) => {
        refs.check = fn
      }
    }
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

import { installPermissionGuards, isPermissionAllowed } from '../src/main/security/permissions'

installPermissionGuards()

// Electron/Chromium 实际会抛出的权限名
const KNOWN_PERMISSIONS = [
  'media',
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  'midiSysex',
  'fullscreen',
  'pointerLock',
  'display-capture',
  'hid',
  'serial',
  'usb',
  'bluetooth'
]

describe('isPermissionAllowed — 默认拒绝纯函数', () => {
  it.each(KNOWN_PERMISSIONS)('权限 %s → false', (permission) => {
    expect(isPermissionAllowed(permission)).toBe(false)
  })

  it('任何来源 URL 均不影响拒绝结果', () => {
    expect(isPermissionAllowed('media', 'file:///C:/PocketAI/renderer/index.html')).toBe(false)
    expect(isPermissionAllowed('media', 'data:text/html,xxx')).toBe(false)
    expect(isPermissionAllowed('media', 'https://localhost:5173/')).toBe(false)
    expect(isPermissionAllowed('geolocation', 'https://app.local/')).toBe(false)
  })

  it('空/未定义输入同样拒绝', () => {
    expect(isPermissionAllowed('')).toBe(false)
  })
})

describe('setPermissionRequestHandler — 所有请求 callback(false)', () => {
  it.each(KNOWN_PERMISSIONS)('权限请求 %s → callback(false)', (permission) => {
    const cb = vi.fn()
    refs.request!(null, permission, cb, { requestingUrl: 'file:///C:/PocketAI/renderer/index.html' })
    expect(cb).toHaveBeenCalledWith(false)
  })

  it('js_eval 隐藏窗口（data: 来源）请求 media → 拒绝', () => {
    const cb = vi.fn()
    refs.request!(null, 'media', cb, { requestingUrl: 'data:text/html;charset=utf-8,xxx' })
    expect(cb).toHaveBeenCalledWith(false)
  })

  it('requestingUrl 缺失也不影响拒绝', () => {
    const cb = vi.fn()
    refs.request!(null, 'notifications', cb, {})
    expect(cb).toHaveBeenCalledWith(false)
  })

  it('未知/未来权限 → 默认拒绝（禁止白名单外放行）', () => {
    const cb = vi.fn()
    refs.request!(null, 'some-future-permission', cb, { requestingUrl: 'https://localhost/' })
    expect(cb).toHaveBeenCalledWith(false)
  })
})

describe('setPermissionCheckHandler — 所有检查返回 false', () => {
  it.each(KNOWN_PERMISSIONS)('权限检查 %s → false', (permission) => {
    expect(refs.check!(null, permission)).toBe(false)
  })

  it('未知权限检查 → false', () => {
    expect(refs.check!(null, 'some-future-permission')).toBe(false)
  })
})
