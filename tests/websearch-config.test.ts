// 联网搜索配置测试（P0 可插拔 provider）
//
// 覆盖：
// - 渲染视图永不回传 Key 明文（apiKey='' + hasKey）
// - provider 白名单 tavily/bocha/searxng
// - 按 provider 隔离密钥（tavily/bocha 各一键，切换不串发）
// - 旧单槽 Key → 按 provider 键的一次性幂等迁移
// - SearXNG 地址：http/https、≤512、无账号密码/query/fragment、末尾斜杠规整
// - 私网确认边界：默认允许位为 false；仅私网地址可置 true；公网/空地址强制回落 false
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const cfgStore = new Map<string, string>()
  const secretStore = new Map<string, string>()
  return {
    cfgStore,
    secretStore,
    appConfigRepo: {
      get: (k: string) => cfgStore.get(k) ?? null,
      set: (k: string, v: string) => {
        cfgStore.set(k, v)
      },
      delete: (k: string) => {
        cfgStore.delete(k)
      }
    },
    secretStoreApi: {
      getSecret: (k: string) => secretStore.get(k) ?? '',
      setSecret: (k: string, v: string) => {
        if (v === '') secretStore.delete(k)
        else secretStore.set(k, v)
      },
      hasSecret: (k: string) => secretStore.has(k) && secretStore.get(k)!.length > 0
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('../src/main/crypto/secret-store', () => ({
  getSecret: mocks.secretStoreApi.getSecret,
  setSecret: mocks.secretStoreApi.setSecret,
  hasSecret: mocks.secretStoreApi.hasSecret,
  SECRET_KV_KEYS: {
    WEBSEARCH_API_KEY: 'agent.websearch_api_key',
    WEBSEARCH_TAVILY_KEY: 'agent.websearch_tavily_key',
    WEBSEARCH_BOCHA_KEY: 'agent.websearch_bocha_key'
  }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

import {
  getWebSearchConfig,
  setWebSearchConfig,
  getWebSearchSecret,
  normalizeSearxngBaseUrl,
  migrateLegacyWebSearchKey
} from '../src/main/tools/websearch-config'
import { WEB_SEARCH_DEPTHS, WEB_SEARCH_DEPTH_SETTINGS } from '../src/shared/types'

const TAVILY_KEY = 'agent.websearch_tavily_key'
const BOCHA_KEY = 'agent.websearch_bocha_key'
const LEGACY_KEY = 'agent.websearch_api_key'

beforeEach(() => {
  mocks.cfgStore.clear()
  mocks.secretStore.clear()
})

describe('getWebSearchConfig — 渲染端视图（不含 Key 明文）', () => {
  it('未配置 → 默认 tavily、关闭、无 Key、SearXNG 空', () => {
    const c = getWebSearchConfig()
    expect(c).toMatchObject({
      enabled: false,
      provider: 'tavily',
      apiKey: '',
      hasKey: false,
      searxngBaseUrl: '',
      searxngAllowPrivate: false
    })
  })

  it('已存当前 provider 的 Key → hasKey=true 但 apiKey 仍为空串', () => {
    mocks.secretStore.set(TAVILY_KEY, 'sk-actual-secret')
    const c = getWebSearchConfig()
    expect(c.hasKey).toBe(true)
    expect(c.apiKey).toBe('')
  })

  it('provider=searxng → hasKey 恒为 false（免 Key）', () => {
    mocks.cfgStore.set('agent.websearch_provider', 'searxng')
    mocks.secretStore.set(TAVILY_KEY, 'sk-tavily')
    expect(getWebSearchConfig().hasKey).toBe(false)
  })

  it('provider 非法值 → 回退 tavily', () => {
    mocks.cfgStore.set('agent.websearch_provider', 'google')
    expect(getWebSearchConfig().provider).toBe('tavily')
  })
})

describe('按 provider 隔离密钥', () => {
  it('切到 bocha：tavily 的 Key 不参与 hasKey，也不被读取', () => {
    setWebSearchConfig({ provider: 'tavily', apiKey: 'sk-tavily' })
    setWebSearchConfig({ provider: 'bocha' })
    expect(getWebSearchConfig().hasKey).toBe(false)
    expect(getWebSearchSecret().apiKey).toBe('')
  })

  it('切回 tavily：原 Key 仍在，可直接使用', () => {
    setWebSearchConfig({ provider: 'tavily', apiKey: 'sk-tavily' })
    setWebSearchConfig({ provider: 'bocha', apiKey: 'sk-bocha' })
    setWebSearchConfig({ provider: 'tavily' })
    expect(getWebSearchConfig().hasKey).toBe(true)
    expect(getWebSearchSecret().apiKey).toBe('sk-tavily')
    expect(mocks.secretStore.get(BOCHA_KEY)).toBe('sk-bocha')
  })

  it('清除 Key 只清当前 provider 的槽位', () => {
    setWebSearchConfig({ provider: 'tavily', apiKey: 'sk-tavily' })
    setWebSearchConfig({ provider: 'bocha', apiKey: 'sk-bocha' })
    setWebSearchConfig({ provider: 'tavily', apiKey: '' })
    expect(mocks.secretStore.has(TAVILY_KEY)).toBe(false)
    expect(mocks.secretStore.get(BOCHA_KEY)).toBe('sk-bocha')
  })

  it('apiKey > 256 字符 → 抛错且不存储', () => {
    expect(() => setWebSearchConfig({ apiKey: 'a'.repeat(257) })).toThrow('上限 256')
    expect(mocks.secretStore.has(TAVILY_KEY)).toBe(false)
  })
})

describe('SearXNG 地址校验与私网确认', () => {
  it('http/https 合法，去首尾空白与末尾斜杠', () => {
    expect(normalizeSearxngBaseUrl(' https://searx.example.com/ ')).toEqual({
      url: 'https://searx.example.com',
      privateHost: false
    })
  })

  it('规整结果：去尾斜杠、保留子路径、origin 保留端口', () => {
    expect(normalizeSearxngBaseUrl('http://127.0.0.1:8080/searxng/')).toEqual({
      url: 'http://127.0.0.1:8080/searxng',
      privateHost: true
    })
  })

  it('非 http/https → 抛错', () => {
    expect(() => normalizeSearxngBaseUrl('ftp://searx.example.com')).toThrow('仅支持 http')
  })

  it('地址含账号密码 / query / fragment → 抛错', () => {
    expect(() => normalizeSearxngBaseUrl('https://u:p@searx.example.com')).toThrow('账号密码')
    expect(() => normalizeSearxngBaseUrl('https://searx.example.com/?x=1')).toThrow('查询参数')
    expect(() => normalizeSearxngBaseUrl('https://searx.example.com/#x')).toThrow('锚点')
  })

  it('> 512 字符 → 抛错', () => {
    expect(() => normalizeSearxngBaseUrl(`https://${'a'.repeat(520)}.com`)).toThrow('上限 512')
  })

  it('私网地址默认不写入允许位；显式确认后可置 true', () => {
    setWebSearchConfig({ searxngBaseUrl: 'http://127.0.0.1:8080' })
    expect(getWebSearchConfig().searxngAllowPrivate).toBe(false)
    setWebSearchConfig({ searxngAllowPrivate: true })
    expect(getWebSearchConfig().searxngAllowPrivate).toBe(true)
  })

  it('公网地址强制回落 false（防止旧确认在改地址后被继承）', () => {
    setWebSearchConfig({ searxngBaseUrl: 'http://127.0.0.1:8080', searxngAllowPrivate: true })
    setWebSearchConfig({ searxngBaseUrl: 'https://searx.example.com' })
    expect(getWebSearchConfig().searxngAllowPrivate).toBe(false)
    expect(getWebSearchConfig().searxngBaseUrl).toBe('https://searx.example.com')
  })

  it('清空地址 → 同步清掉允许位', () => {
    setWebSearchConfig({ searxngBaseUrl: 'http://127.0.0.1:8080', searxngAllowPrivate: true })
    setWebSearchConfig({ searxngBaseUrl: '' })
    expect(getWebSearchConfig().searxngBaseUrl).toBe('')
    expect(getWebSearchConfig().searxngAllowPrivate).toBe(false)
  })

  it('非法地址不应顺带改掉 enabled/provider', () => {
    setWebSearchConfig({ enabled: true, provider: 'searxng' })
    expect(() => setWebSearchConfig({ searxngBaseUrl: 'ftp://x' })).toThrow()
    const c = getWebSearchConfig()
    expect(c.enabled).toBe(true)
    expect(c.provider).toBe('searxng')
  })
})

describe('历史单槽 Key 迁移（幂等）', () => {
  it('provider=tavily：legacy → tavily 槽，并删除 legacy', () => {
    mocks.secretStore.set(LEGACY_KEY, 'sk-legacy')
    migrateLegacyWebSearchKey()
    expect(mocks.secretStore.get(TAVILY_KEY)).toBe('sk-legacy')
    expect(mocks.secretStore.has(LEGACY_KEY)).toBe(false)
  })

  it('provider=bocha：迁移到 bocha 槽', () => {
    mocks.cfgStore.set('agent.websearch_provider', 'bocha')
    mocks.secretStore.set(LEGACY_KEY, 'sk-legacy')
    migrateLegacyWebSearchKey()
    expect(mocks.secretStore.get(BOCHA_KEY)).toBe('sk-legacy')
    expect(mocks.secretStore.has(LEGACY_KEY)).toBe(false)
  })

  it('目标槽已有 Key → 不覆盖，仍删除 legacy', () => {
    mocks.secretStore.set(TAVILY_KEY, 'sk-new')
    mocks.secretStore.set(LEGACY_KEY, 'sk-legacy')
    migrateLegacyWebSearchKey()
    expect(mocks.secretStore.get(TAVILY_KEY)).toBe('sk-new')
    expect(mocks.secretStore.has(LEGACY_KEY)).toBe(false)
  })

  it('重复执行幂等（第二次无 legacy 可迁，不改任何槽）', () => {
    mocks.secretStore.set(LEGACY_KEY, 'sk-legacy')
    migrateLegacyWebSearchKey()
    const before = new Map(mocks.secretStore)
    migrateLegacyWebSearchKey()
    expect(new Map(mocks.secretStore)).toEqual(before)
  })
})

describe('搜索深度档位（depth: auto/quick/deep）', () => {
  it('默认 auto（不干预模型选择）', () => {
    expect(getWebSearchConfig().depth).toBe('auto')
    expect(getWebSearchSecret().depth).toBe('auto')
  })

  // 回归（真机报错：配置侧枚举只收 quick|deep，保存 auto 被 IPC 入参校验拒掉）：
  // 三档都必须能存进 KV、读回同值；auto 覆盖已存的 quick 后也不许被脏值回落成 quick。
  it.each(['auto', 'quick', 'deep'] as const)(
    '保存 %s 后落库、视图与主进程明文一致',
    (depth) => {
      // 预置另一档，确保本次保存真的覆盖了旧值（尤其覆盖掉 auto 的"读取期默认值"）
      setWebSearchConfig({ depth: depth === 'auto' ? 'quick' : 'auto' })
      setWebSearchConfig({ depth })
      expect(mocks.cfgStore.get('agent.websearch_depth')).toBe(depth)
      expect(getWebSearchConfig().depth).toBe(depth)
      expect(getWebSearchSecret().depth).toBe(depth)
    }
  )

  it('配置侧三档、模型侧仍只 quick|deep（两处枚举不混用）', () => {
    expect([...WEB_SEARCH_DEPTH_SETTINGS]).toEqual(['auto', 'quick', 'deep'])
    expect([...WEB_SEARCH_DEPTHS]).toEqual(['quick', 'deep'])
  })

  it('非法持久化值 → 回落 auto（不在读取处替用户强制档位）', () => {
    mocks.cfgStore.set('agent.websearch_depth', 'turbo')
    expect(getWebSearchConfig().depth).toBe('auto')
  })

  it('只改 depth 不影响 enabled/provider', () => {
    setWebSearchConfig({ enabled: true, provider: 'searxng' })
    setWebSearchConfig({ depth: 'deep' })
    const c = getWebSearchConfig()
    expect(c.enabled).toBe(true)
    expect(c.provider).toBe('searxng')
    expect(c.depth).toBe('deep')
  })
})

describe('getWebSearchSecret — 主进程读明文与 SearXNG 配置', () => {
  it('返回当前 provider 的 Key 明文', () => {
    setWebSearchConfig({ provider: 'bocha', apiKey: 'sk-plaintext' })
    expect(getWebSearchSecret().apiKey).toBe('sk-plaintext')
  })

  it('返回 searxngBaseUrl / searxngAllowPrivate', () => {
    setWebSearchConfig({
      provider: 'searxng',
      searxngBaseUrl: 'http://127.0.0.1:8080',
      searxngAllowPrivate: true
    })
    const s = getWebSearchSecret()
    expect(s.provider).toBe('searxng')
    expect(s.searxngBaseUrl).toBe('http://127.0.0.1:8080')
    expect(s.searxngAllowPrivate).toBe(true)
  })
})
