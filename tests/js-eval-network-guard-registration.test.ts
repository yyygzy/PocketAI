// 沙箱网络守卫的「真注册」那一层（V4-Iter-172，B11 对账时现查的零覆盖）
//
// `isAllowedSandboxUrl` 早有 6 例钉判据，但**守卫到底挂没挂上、挂上后回调回什么**此前没人证——
// 而那才是"沙箱执行层禁网"真正生效的地方（SEC-17）。这里整块打桩 electron 的 session，
// 把真注册进去的那个 handler 取出来喂 URL。
import { describe, it, expect, vi } from 'vitest'

const reg = vi.hoisted(() => ({
  partitions: [] as string[],
  requestHandlers: [] as Array<(details: { url: string }, cb: (r: { cancel: boolean }) => void) => void>,
  permissionRequest: null as null | ((wc: unknown, permission: string, cb: (allow: boolean) => void) => void),
  permissionCheck: null as null | ((wc: unknown, permission: string) => boolean)
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: (name: string) => {
      reg.partitions.push(name)
      return {
        webRequest: {
          onBeforeRequest: (h: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) => {
            reg.requestHandlers.push(h)
          }
        },
        setPermissionRequestHandler: (
          h: (wc: unknown, permission: string, cb: (allow: boolean) => void) => void
        ) => {
          reg.permissionRequest = h
        },
        setPermissionCheckHandler: (h: (wc: unknown, permission: string) => boolean) => {
          reg.permissionCheck = h
        }
      }
    }
  }
}))

import { ensureNetworkGuard, isAllowedSandboxUrl } from '../src/main/sandbox/js-eval-runner'

/** 用真注册进去的回调跑一次，拿 Chromium 收到的那个决定 */
function decide(url: string): { cancel: boolean } {
  const handler = reg.requestHandlers[0]
  if (!handler) throw new Error('webRequest.onBeforeRequest 根本没被注册（守卫没挂上）')
  let out: { cancel: boolean } | null = null
  handler({ url }, (r) => {
    out = r
  })
  if (!out) throw new Error('回调没有答复 Chromium：请求会一直挂着，比放行更糟')
  return out
}

describe('沙箱 webRequest 守卫的真接线', () => {
  it('挂的是沙箱那个 partition，不是一句"挂了"就完事', () => {
    ensureNetworkGuard()
    expect(reg.partitions).toEqual(['pocketai-sandbox'])
  })

  it('外发 URL 一律 cancel（这是此前只有纯函数被证过的那一半）', () => {
    ensureNetworkGuard()
    for (const url of [
      'https://example.com',
      'http://127.0.0.1:11434/api/chat',
      'ws://example.com/socket',
      'file:///C:/Windows/win.ini',
      'blob:http://example.com/xyz'
    ]) {
      expect(decide(url).cancel, `${url} 应当被 cancel`).toBe(true)
    }
  })

  it('只放行自举用的 data: / about:blank', () => {
    ensureNetworkGuard()
    expect(decide('data:text/html;charset=utf-8,%3Chtml%3E').cancel).toBe(false)
    expect(decide('about:blank').cancel).toBe(false)
  })

  it('与 isAllowedSandboxUrl 同源：判据函数说行的，回调就不 cancel（两处不许各漂一份）', () => {
    ensureNetworkGuard()
    for (const url of ['data:text/html,x', 'about:blank', 'https://a.b', 'file:///tmp/x']) {
      expect(decide(url).cancel).toBe(!isAllowedSandboxUrl(url))
    }
  })

  it('幂等：重复调用不重复注册（一次挂守卫，多次进沙箱不叠回调）', () => {
    ensureNetworkGuard()
    const n = reg.requestHandlers.length
    ensureNetworkGuard()
    expect(reg.requestHandlers.length).toBe(n)
  })

  it('双保险：沙箱不要任何 Chromium 权限，两个 handler 都得给 false', () => {
    ensureNetworkGuard()
    expect(typeof reg.permissionRequest).toBe('function')
    let allowed: boolean | null = null
    reg.permissionRequest?.({}, 'clipboard-sanitized-write', (ok) => {
      allowed = ok
    })
    expect(allowed).toBe(false)
    expect(reg.permissionCheck?.({}, 'notifications')).toBe(false)
  })
})
