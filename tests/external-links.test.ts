// external-links 外链安全测试
//
// 覆盖 src/main/net/external-links.ts 的 URL 安全边界：
// - openExternalSecure：仅放行 http/https，其余协议静默拒绝
// - originOf：URL origin 提取，非法返回 null
// - denyNewWindows：拒开新窗 + 跨源导航拦截（同源放行、跨源阻止并转系统浏览器）
//
// 策略：vi.mock electron shell 捕获 openExternal 调用；denyNewWindows 用 mock
// webContents 手动触发 setWindowOpenHandler / will-navigate 回调。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({
  shell: { openExternal: openExternalMock }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} })
}))

import { openExternalSecure, originOf, denyNewWindows } from '../src/main/net/external-links'

beforeEach(() => {
  openExternalMock.mockClear()
})

describe('openExternalSecure — 仅放行 http/https', () => {
  it('http → 调用 shell.openExternal', () => {
    openExternalSecure('http://example.com/page')
    expect(openExternalMock).toHaveBeenCalledWith('http://example.com/page')
  })

  it('https → 调用 shell.openExternal', () => {
    openExternalSecure('https://example.com/page')
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/page')
  })

  it('file:// → 静默拒绝（不调用）', () => {
    openExternalSecure('file:///etc/passwd')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('javascript: → 静默拒绝', () => {
    openExternalSecure('javascript:alert(1)')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('ftp:// → 静默拒绝', () => {
    openExternalSecure('ftp://example.com/file')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('data: → 静默拒绝', () => {
    openExternalSecure('data:text/html,<script>alert(1)</script>')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('自定义协议 → 静默拒绝', () => {
    openExternalSecure('custom-scheme://dangerous')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('非法/相对 URL → 静默拒绝', () => {
    openExternalSecure('not-a-url')
    openExternalSecure('/relative/path')
    expect(openExternalMock).not.toHaveBeenCalled()
  })
})

describe('originOf — URL origin 提取', () => {
  it('http URL → 正确 origin', () => {
    expect(originOf('http://example.com:8080/path')).toBe('http://example.com:8080')
  })

  it('https URL → 正确 origin', () => {
    expect(originOf('https://example.com/path')).toBe('https://example.com')
  })

  it('file:// → origin 为字符串 "null"（浏览器同源策略）', () => {
    expect(originOf('file:///C:/test')).toBe('null')
  })

  it('非法 URL → null', () => {
    expect(originOf('not-a-url')).toBeNull()
    expect(originOf('')).toBeNull()
  })
})

describe('denyNewWindows — 拒开新窗 + 跨源导航拦截', () => {
  function mockWebContents(currentUrl: string) {
    let openHandler: ((details: { url: string }) => { action: string }) | null = null
    let navigateHandler: ((e: { preventDefault: () => void }, url: string) => void) | null = null
    const preventDefaultMock = vi.fn()
    return {
      setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => {
        openHandler = fn
      },
      on: (event: string, fn: (e: { preventDefault: () => void }, url: string) => void) => {
        if (event === 'will-navigate') navigateHandler = fn
      },
      getURL: () => currentUrl,
      _triggerOpen: (url: string) => openHandler!({ url }),
      _triggerNavigate: (url: string) => navigateHandler!({ preventDefault: preventDefaultMock }, url),
      _preventDefaultMock: preventDefaultMock
    }
  }

  it('window.open 始终返回 deny，并把合法 URL 转系统浏览器', () => {
    const wc = mockWebContents('https://app.local')
    denyNewWindows(wc as unknown as Electron.WebContents)
    const result = wc._triggerOpen('https://external.com/page')
    expect(result.action).toBe('deny')
    expect(openExternalMock).toHaveBeenCalledWith('https://external.com/page')
  })

  it('window.open 非 http(s) URL → deny 且不转系统浏览器', () => {
    const wc = mockWebContents('https://app.local')
    denyNewWindows(wc as unknown as Electron.WebContents)
    wc._triggerOpen('javascript:alert(1)')
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('同源导航 → 放行（不 preventDefault）', () => {
    const wc = mockWebContents('https://app.local')
    denyNewWindows(wc as unknown as Electron.WebContents)
    wc._triggerNavigate('https://app.local/#/settings')
    expect(wc._preventDefaultMock).not.toHaveBeenCalled()
  })

  it('跨源导航 → preventDefault + 转系统浏览器', () => {
    const wc = mockWebContents('https://app.local')
    denyNewWindows(wc as unknown as Electron.WebContents)
    wc._triggerNavigate('https://evil.com/phish')
    expect(wc._preventDefaultMock).toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledWith('https://evil.com/phish')
  })

  it('跨源导航非 http(s) → preventDefault 但不转系统浏览器', () => {
    const wc = mockWebContents('https://app.local')
    denyNewWindows(wc as unknown as Electron.WebContents)
    wc._triggerNavigate('file:///etc/passwd')
    expect(wc._preventDefaultMock).toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })
})
