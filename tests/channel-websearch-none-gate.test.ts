// 渠道 token / 联网搜索 Key 的 none 模式写入闸（SEC-1 方案 / 主进程权威）
//
// 这两条原来只靠渲染层确认（B3），注入渲染层即可绕过。现在与 provider/MCP 同级：
// 主进程按**值**判定，拒绝新增密钥材料，但放行三类不产生新密钥的写入
// （清空、回填原值、只改非密钥字段），库存量凭据保持可读可删。
// 用真 sqlite(:memory:) + 真 app_config 仓储跑，断言「拦什么、放什么」两条边界。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'db',
  key: Buffer.alloc(32, 9),
  db: null as unknown as Database.Database
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    on: () => {},
    quit: () => {}
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.mode,
    getFieldKey: () => mocks.key,
    hasKey: () => true
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => mocks.db }
}))

import { setChannelConfig, getChannelConfig } from '../src/main/channels/channel-config'
import { setWebSearchConfig, getWebSearchConfig } from '../src/main/tools/websearch-config'
import { setSecret, hasSecret, SECRET_KV_KEYS, getSecret } from '../src/main/crypto/secret-store'

const DDL = `
  CREATE TABLE app_config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
  )`

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'none'
})

/** 先在 db 模式写一条存量凭据，再切回 none（模拟「曾经设过主密码、后来关掉」） */
function seedInDbMode(key: string, value: string): void {
  mocks.mode = 'db'
  setSecret(key, value)
  mocks.mode = 'none'
}

describe('渠道凭据：none 模式拒绝新增，不产生半条记录', () => {
  it('新 Telegram token → 拒绝落库，且 app_config 无该键', () => {
    expect(() => setChannelConfig('telegram', { primarySecret: '123456:ABC-new' })).toThrow(/未设置主密码/)
    expect(hasSecret(SECRET_KV_KEYS.TELEGRAM_TOKEN)).toBe(false)
  })

  it('拒绝文案不含凭据值', () => {
    let message = ''
    try {
      setChannelConfig('telegram', { primarySecret: '123456:ABC-leak-check' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('渠道主凭据')
    expect(message).not.toContain('123456:ABC-leak-check')
  })

  it('db 模式同样内容正常写入，且落盘为 v1 密文', () => {
    mocks.mode = 'db'
    setChannelConfig('telegram', { primarySecret: '123456:ABC-ok' })
    const raw = (mocks.db.prepare('SELECT value AS v FROM app_config WHERE key=?').get(SECRET_KV_KEYS.TELEGRAM_TOKEN) as {
      v: string
    }).v
    expect(raw.startsWith('v1:')).toBe(true)
    expect(getSecret(SECRET_KV_KEYS.TELEGRAM_TOKEN)).toBe('123456:ABC-ok')
  })

  it('none 模式清除存量凭据 → 放行（删除不是新增）', () => {
    seedInDbMode(SECRET_KV_KEYS.TELEGRAM_TOKEN, '123456:ABC-old')
    setChannelConfig('telegram', { primarySecret: '' })
    expect(hasSecret(SECRET_KV_KEYS.TELEGRAM_TOKEN)).toBe(false)
    expect(getChannelConfig('telegram').hasPrimarySecret).toBe(false)
  })

  it('none 模式只改非凭据字段（不下发 secret）→ 放行，存量令牌原样保留', () => {
    seedInDbMode(SECRET_KV_KEYS.TELEGRAM_TOKEN, '123456:ABC-keep')
    setChannelConfig('telegram', { whitelist: '111,222' })
    expect(getSecret(SECRET_KV_KEYS.TELEGRAM_TOKEN)).toBe('123456:ABC-keep')
    expect(getChannelConfig('telegram').whitelist).toBe('111,222')
  })

  it('none 模式回填与原值完全相同的字符串 → 放行（没有新密钥材料）', () => {
    seedInDbMode(SECRET_KV_KEYS.TELEGRAM_TOKEN, '123456:ABC-same')
    expect(() => setChannelConfig('telegram', { primarySecret: '123456:ABC-same' })).not.toThrow()
    expect(getSecret(SECRET_KV_KEYS.TELEGRAM_TOKEN)).toBe('123456:ABC-same')
  })
})

describe('联网搜索 Key：none 模式拒绝新增', () => {
  it('新 Key → 拒绝落库', () => {
    expect(() => setWebSearchConfig({ apiKey: 'tvly-new' })).toThrow(/未设置主密码/)
    expect(hasSecret(SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY)).toBe(false)
  })

  it('none 模式清除存量 Key → 放行', () => {
    seedInDbMode(SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY, 'tvly-old')
    setWebSearchConfig({ apiKey: '' })
    expect(hasSecret(SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY)).toBe(false)
  })

  it('none 模式只改 provider / 地址 → 放行，存量 Key 原样保留', () => {
    seedInDbMode(SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY, 'tvly-keep')
    setWebSearchConfig({ provider: 'tavily', depth: 'quick' })
    expect(getSecret(SECRET_KV_KEYS.WEBSEARCH_TAVILY_KEY)).toBe('tvly-keep')
    expect(getWebSearchConfig().depth).toBe('quick')
  })
})
