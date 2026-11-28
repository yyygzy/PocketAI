// WebDAV 传输协议守卫测试（SEC-16-06）
//
// 覆盖 src/main/backup/webdav-client.ts buildClient 的回环放行 / 非回环强制 https：
// - 非回环 http → 拒绝（Basic(base64) 会明文携带长期账号口令）
// - 回环 http（localhost / 127.* / [::1]）→ 放行
// - https → 放行
// - 非 http/https 协议 → 拒绝（既有白名单）
//
// 策略：buildClient 是私有函数，经公开入口 testConnection 观察（拒绝时错误文案
// 原样带回 message）；webdav 模块打桩，回环/https 放行分支不真发网络请求。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebDAVClient } from 'webdav'

const { mockExists } = vi.hoisted(() => ({ mockExists: vi.fn() }))

vi.mock('webdav', () => ({
  AuthType: { Auto: 'auto', Digest: 'digest', Password: 'password', Token: 'token', None: 'none' },
  createClient: () =>
    ({
      exists: mockExists
    } as unknown as WebDAVClient)
}))

import { testConnection } from '../src/main/backup/webdav-client'
import type { WebDAVCredentials } from '../src/main/backup/webdav-client'

function creds(url: string): WebDAVCredentials {
  return { url, username: 'user', password: 'pass' }
}

beforeEach(() => {
  mockExists.mockReset()
  mockExists.mockResolvedValue(true)
})

describe('SEC-16-06 — 非回环 http 拒绝', () => {
  it('公网域名 http → 拒绝，报错带 https 要求与明文口令原因', async () => {
    const r = await testConnection(creds('http://nas.example.com:5005/dav'))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('必须使用 https')
    expect(r.message).toContain('Basic(base64)')
  })

  it('内网 IP http（常见的 NAS 写法）→ 同样拒绝', async () => {
    const r = await testConnection(creds('http://192.168.1.10:5005/dav'))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('必须使用 https')
  })
})

describe('SEC-16-06 — 回环 http 放行', () => {
  it('http://127.0.0.1:PORT → 放行（走到桩的 exists）', async () => {
    const r = await testConnection(creds('http://127.0.0.1:5005/dav'))
    expect(r.ok).toBe(true)
    expect(mockExists).toHaveBeenCalled()
  })

  it('http://localhost → 放行', async () => {
    const r = await testConnection(creds('http://localhost/dav'))
    expect(r.ok).toBe(true)
  })

  it('http://[::1] → 放行（IPv6 回环，URL.hostname 带方括号）', async () => {
    const r = await testConnection(creds('http://[::1]/dav'))
    expect(r.ok).toBe(true)
  })

  it('http://127.7.3.9 → 放行（127.0.0.0/8 整段都是回环）', async () => {
    const r = await testConnection(creds('http://127.7.3.9/dav'))
    expect(r.ok).toBe(true)
  })
})

describe('SEC-16-06 — https 放行 / 非 http(s) 协议拒绝', () => {
  it('https 公网域名 → 放行', async () => {
    const r = await testConnection(creds('https://cloud.example.com/dav'))
    expect(r.ok).toBe(true)
  })

  it('ftp: → 既有协议白名单拒绝', async () => {
    const r = await testConnection(creds('ftp://nas.example.com/dav'))
    expect(r.ok).toBe(false)
    expect(r.message).toContain('仅支持 http/https')
  })
})
