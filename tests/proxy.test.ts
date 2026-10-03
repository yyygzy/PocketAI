// HTTP 代理：normalizeProxyUrl 纯函数 + applyProxySettings / saveProxyUrl 行为
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setGlobalDispatcher: vi.fn(),
  undiciFetch: function undiciFetch() {},
  agents: [] as Array<Record<string, unknown>>,
  proxyAgents: [] as Array<{ httpProxy?: string; httpsProxy?: string; noProxy?: string }>
}))

// safe-handle → electron(ipcMain) 链
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: () => {} }
}))

vi.mock('undici', () => ({
  Agent: class {
    constructor() { mocks.agents.push({ kind: 'agent' }) }
  },
  EnvHttpProxyAgent: class {
    constructor(opts: { httpProxy?: string; httpsProxy?: string; noProxy?: string }) {
      mocks.proxyAgents.push(opts)
    }
  },
  fetch: mocks.undiciFetch,
  setGlobalDispatcher: mocks.setGlobalDispatcher
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getProxyUrl: () => mocks.store.get('net_proxy_url') ?? '',
    setProxyUrl: (v: string) => {
      if (v) mocks.store.set('net_proxy_url', v)
      else mocks.store.delete('net_proxy_url')
    }
  }
}))

import {
  normalizeProxyUrl,
  applyProxySettings,
  saveProxyUrl
} from '../src/main/net/proxy'

beforeEach(() => {
  mocks.store.clear()
  mocks.setGlobalDispatcher.mockClear()
  mocks.agents.length = 0
  mocks.proxyAgents.length = 0
})

describe('normalizeProxyUrl', () => {
  it('空值与空白 → null（直连语义）', () => {
    expect(normalizeProxyUrl('')).toBeNull()
    expect(normalizeProxyUrl('   ')).toBeNull()
    expect(normalizeProxyUrl(null)).toBeNull()
    expect(normalizeProxyUrl(undefined)).toBeNull()
  })

  it('http/https 合法地址：trim + 去末尾斜杠；https 原样', () => {
    expect(normalizeProxyUrl('  http://127.0.0.1:7890/ ')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('http://127.0.0.1:7890///')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('https://proxy.example.com:8080')).toBe('https://proxy.example.com:8080')
  })

  it('保留内嵌认证信息', () => {
    expect(normalizeProxyUrl('http://user:p%40ss@127.0.0.1:7890'))
      .toBe('http://user:p%40ss@127.0.0.1:7890')
  })

  it('socks5 / ftp / 无协议串 / 缺主机 一律抛错', () => {
    expect(() => normalizeProxyUrl('socks5://127.0.0.1:7890')).toThrow(/socks5/)
    expect(() => normalizeProxyUrl('ftp://127.0.0.1:21')).toThrow(/http/)
    expect(() => normalizeProxyUrl('not-a-url')).toThrow()
    expect(() => normalizeProxyUrl('127.0.0.1:7890')).toThrow()
    expect(() => normalizeProxyUrl('http://')).toThrow()
  })
})

describe('applyProxySettings', () => {
  it('无配置：装直连 Agent；非空配置：装 EnvHttpProxyAgent 且回环地址直连', () => {
    applyProxySettings()
    expect(mocks.setGlobalDispatcher).toHaveBeenCalledTimes(1)
    expect(mocks.agents).toHaveLength(1)
    expect(mocks.proxyAgents).toHaveLength(0)

    mocks.store.set('net_proxy_url', 'http://127.0.0.1:7890')
    applyProxySettings()
    expect(mocks.proxyAgents).toHaveLength(1)
    const opts = mocks.proxyAgents[0]!
    expect(opts).toEqual({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: expect.stringContaining('127.0.0.1')
    })
    expect(opts.noProxy).toContain('localhost')
  })

  it('首次应用后全局 fetch 被替换为 undici fetch', () => {
    applyProxySettings()
    expect(globalThis.fetch).toBe(mocks.undiciFetch as unknown as typeof fetch)
  })
})

describe('saveProxyUrl', () => {
  it('合法地址：规整、写库、立即应用并返回规整值', () => {
    const r = saveProxyUrl('http://127.0.0.1:7890/')
    expect(r).toBe('http://127.0.0.1:7890')
    expect(mocks.store.get('net_proxy_url')).toBe('http://127.0.0.1:7890')
    expect(mocks.proxyAgents).toHaveLength(1)
  })
  it('空串：写空（删键）并恢复直连 Agent', () => {
    mocks.store.set('net_proxy_url', 'http://old:1')
    expect(saveProxyUrl('   ')).toBe('')
    expect(mocks.store.has('net_proxy_url')).toBe(false)
    expect(mocks.agents.length).toBeGreaterThan(0)
  })
  it('非法地址抛错且不写库', () => {
    mocks.store.set('net_proxy_url', 'http://old:1')
    expect(() => saveProxyUrl('socks5://127.0.0.1:7890')).toThrow()
    expect(mocks.store.get('net_proxy_url')).toBe('http://old:1')
  })
})
