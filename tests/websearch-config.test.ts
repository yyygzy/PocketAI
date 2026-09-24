// websearch-config 联网搜索配置测试
//
// 覆盖 src/main/tools/websearch-config.ts 的三个函数：
// - getWebSearchConfig：渲染端视图，永远不回传 Key 明文（apiKey='' + hasKey 标记）
// - setWebSearchConfig：字段白名单 + provider 白名单(tavily/bocha) + apiKey 空串清除 / >256 抛错
// - getWebSearchSecret：主进程内部读取 Key 明文
//
// 策略：vi.hoisted mock appConfigRepo(Map) + secret-store(Map)，隔离 KV 与凭据存储。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const cfgStore = new Map<string, string>()
  const secretStore = new Map<string, string>()
  return {
    cfgStore,
    secretStore,
    appConfigRepo: {
      get: (k: string) => cfgStore.get(k) ?? null,
      set: (k: string, v: string) => { cfgStore.set(k, v) },
      delete: (k: string) => { cfgStore.delete(k) }
    },
    secretStoreApi: {
      getSecret: (k: string) => secretStore.get(k) ?? '',
      setSecret: (k: string, v: string) => { if (v === '') secretStore.delete(k); else secretStore.set(k, v) },
      hasSecret: (k: string) => secretStore.has(k) && secretStore.get(k)!.length > 0
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('../src/main/crypto/secret-store', () => ({
  getSecret: mocks.secretStoreApi.getSecret,
  setSecret: mocks.secretStoreApi.setSecret,
  hasSecret: mocks.secretStoreApi.hasSecret,
  SECRET_KV_KEYS: { WEBSEARCH_API_KEY: 'websearch.api_key' }
}))

import { getWebSearchConfig, setWebSearchConfig, getWebSearchSecret } from '../src/main/tools/websearch-config'

beforeEach(() => {
  mocks.cfgStore.clear()
  mocks.secretStore.clear()
})

describe('getWebSearchConfig — 渲染端视图（不含 Key 明文）', () => {
  it('未配置 → enabled=false, provider=tavily, apiKey="", hasKey=false', () => {
    const c = getWebSearchConfig()
    expect(c.enabled).toBe(false)
    expect(c.provider).toBe('tavily')
    expect(c.apiKey).toBe('')
    expect(c.hasKey).toBe(false)
  })

  it('已存 Key → hasKey=true 但 apiKey 仍为空串', () => {
    mocks.secretStore.set('websearch.api_key', 'sk-actual-secret')
    const c = getWebSearchConfig()
    expect(c.hasKey).toBe(true)
    expect(c.apiKey).toBe('')
  })

  it('enabled=1 → true', () => {
    mocks.cfgStore.set('agent.websearch_enabled', '1')
    expect(getWebSearchConfig().enabled).toBe(true)
  })

  it('enabled=其它值 → false', () => {
    mocks.cfgStore.set('agent.websearch_enabled', '0')
    expect(getWebSearchConfig().enabled).toBe(false)
    mocks.cfgStore.set('agent.websearch_enabled', 'yes')
    expect(getWebSearchConfig().enabled).toBe(false)
  })

  it('provider=bocha → bocha', () => {
    mocks.cfgStore.set('agent.websearch_provider', 'bocha')
    expect(getWebSearchConfig().provider).toBe('bocha')
  })

  it('provider=非法值 → 回退 tavily', () => {
    mocks.cfgStore.set('agent.websearch_provider', 'google')
    expect(getWebSearchConfig().provider).toBe('tavily')
  })
})

describe('setWebSearchConfig — 保存配置', () => {
  it('enabled=true → 存 "1"', () => {
    setWebSearchConfig({ enabled: true })
    expect(mocks.cfgStore.get('agent.websearch_enabled')).toBe('1')
  })

  it('enabled=false → 存 "0"', () => {
    setWebSearchConfig({ enabled: false })
    expect(mocks.cfgStore.get('agent.websearch_enabled')).toBe('0')
  })

  it('provider=tavily → 持久化', () => {
    setWebSearchConfig({ provider: 'tavily' })
    expect(mocks.cfgStore.get('agent.websearch_provider')).toBe('tavily')
  })

  it('provider=bocha → 持久化', () => {
    setWebSearchConfig({ provider: 'bocha' })
    expect(mocks.cfgStore.get('agent.websearch_provider')).toBe('bocha')
  })

  it('apiKey 非空 → trim 后存入 secret-store', () => {
    setWebSearchConfig({ apiKey: '  sk-test  ' })
    expect(mocks.secretStore.get('websearch.api_key')).toBe('sk-test')
  })

  it('apiKey 空串 → 清除密钥', () => {
    mocks.secretStore.set('websearch.api_key', 'old-key')
    setWebSearchConfig({ apiKey: '' })
    expect(mocks.secretStore.has('websearch.api_key')).toBe(false)
    expect(getWebSearchConfig().hasKey).toBe(false)
  })

  it('apiKey > 256 字符 → 抛错且不存储', () => {
    const longKey = 'a'.repeat(257)
    expect(() => setWebSearchConfig({ apiKey: longKey })).toThrow('上限 256')
    expect(mocks.secretStore.has('websearch.api_key')).toBe(false)
  })

  it('apiKey 恰好 256 字符 → 可存储', () => {
    const key = 'a'.repeat(256)
    setWebSearchConfig({ apiKey: key })
    expect(mocks.secretStore.get('websearch.api_key')).toBe(key)
  })

  it('不传 apiKey → 不动密钥', () => {
    mocks.secretStore.set('websearch.api_key', 'keep-me')
    setWebSearchConfig({ enabled: true })
    expect(mocks.secretStore.get('websearch.api_key')).toBe('keep-me')
  })

  it('返回最新配置（含 hasKey）', () => {
    const c = setWebSearchConfig({ enabled: true, apiKey: 'sk-x' })
    expect(c.enabled).toBe(true)
    expect(c.apiKey).toBe('')
    expect(c.hasKey).toBe(true)
  })
})

describe('getWebSearchSecret — 主进程读明文 Key', () => {
  it('返回 Key 明文（与 getWebSearchConfig 不同）', () => {
    mocks.secretStore.set('websearch.api_key', 'sk-plaintext')
    const s = getWebSearchSecret()
    expect(s.apiKey).toBe('sk-plaintext')
  })

  it('未配置 Key → 空串', () => {
    expect(getWebSearchSecret().apiKey).toBe('')
  })

  it('enabled/provider 与 getWebSearchConfig 一致', () => {
    mocks.cfgStore.set('agent.websearch_enabled', '1')
    mocks.cfgStore.set('agent.websearch_provider', 'bocha')
    const s = getWebSearchSecret()
    expect(s.enabled).toBe(true)
    expect(s.provider).toBe('bocha')
  })
})
