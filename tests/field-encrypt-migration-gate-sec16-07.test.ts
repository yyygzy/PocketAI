// 字段解密 fail-closed 迁移门测试（SEC-16-07）
//
// 覆盖 src/main/crypto/field-encrypt.ts + src/main/crypto/secret-store.ts：
// - decryptSecret 两态：标记未落 → 明文直通（迁移期兼容旧库）；标记落盘 →
//   非密文形状（历史明文、被截断/改写的 v1: 串）一律返回 '' + warn 日志，
//   而合法密文照常解出、形状合法但 tag 不符照旧 ''（既有 fail-closed 不回归）
// - migrateKvSecrets 的收尾接线：
//   · 入口发现明文残留 → 同步撤回标记（防「标记已落 + 明文入库」时迁移本体把
//     明文读成空串再写回＝凭据被清空）
//   · 宏任务（阶段 3 同步迁移块跑完后）扫描：无明文残留 → 落标记；
//     有明文残留（迁移中途失败）→ 不落标记
//
// 策略：mock appConfigRepo（内存 Map）、dbService（桩 handle + 可控行集）、
// masterKeyManager（固定字段密钥）、logger（捕获 warn 断言）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FIELD_KEY = Buffer.alloc(32, 0x41)

const { store, dbStub, warns } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  dbStub: {
    providerRows: [] as { v: string }[],
    mcpRows: [] as { env: string | null; headers: string | null }[]
  },
  warns: [] as string[]
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getFieldKey: () => FIELD_KEY }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => {
      store.set(key, value)
    },
    delete: (key: string) => {
      store.delete(key)
    }
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('api_key_encrypted') ? dbStub.providerRows : dbStub.mcpRows),
        run: () => {}
      })
    })
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    warn: (msg: string, ...rest: unknown[]) => {
      warns.push(rest.length ? `${msg} ${rest.join(' ')}` : msg)
    },
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  })
}))

import {
  encryptSecret,
  decryptSecret,
  isCipherText,
  PLAINTEXT_MIGRATION_DONE_KEY
} from '../src/main/crypto/field-encrypt'
import { migrateKvSecrets, SECRET_KV_KEYS } from '../src/main/crypto/secret-store'

/** 模拟 index.ts 阶段 3 的同步迁移块跑完：flush 掉宏任务 */
const flushTimer = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const TG = SECRET_KV_KEYS.TELEGRAM_TOKEN

beforeEach(() => {
  store.clear()
  dbStub.providerRows = []
  dbStub.mcpRows = []
  warns.length = 0
})

describe('decryptSecret — 标记未落：迁移期明文直通（兼容旧库）', () => {
  it('历史明文原样返回', () => {
    expect(store.has(PLAINTEXT_MIGRATION_DONE_KEY)).toBe(false)
    expect(decryptSecret('legacy-plaintext-token')).toBe('legacy-plaintext-token')
  })

  it('坏得不成形状的 v1: 串也按明文直通（§384 语义，迁移期不变）', () => {
    expect(decryptSecret('v1:aaa')).toBe('v1:aaa')
  })

  it('合法密文照常解出（直通分支不干扰密文路径）', () => {
    const ct = encryptSecret('real-secret')
    expect(isCipherText(ct)).toBe(true)
    expect(decryptSecret(ct)).toBe('real-secret')
  })

  it('null / undefined → 空串', () => {
    expect(decryptSecret(null)).toBe('')
    expect(decryptSecret(undefined)).toBe('')
  })
})

describe('decryptSecret — 标记已落：fail-closed', () => {
  beforeEach(() => {
    store.set(PLAINTEXT_MIGRATION_DONE_KEY, '1')
  })

  it('历史明文 → 空串 + warn（不再原样带回）', () => {
    expect(decryptSecret('legacy-plaintext-token')).toBe('')
    expect(warns.some((w) => w.includes('按无凭据处理'))).toBe(true)
  })

  it('被截断的密文（v1: 残段）→ 空串，不再返回残值（审计验收项）', () => {
    const ct = encryptSecret('my-secret-token-12345')
    const truncated = ct.slice(0, Math.floor(ct.length / 2))
    expect(isCipherText(truncated)).toBe(false)
    expect(decryptSecret(truncated)).toBe('')
  })

  it('形状合法但 tag 校验失败 → 空串（既有 fail-closed 不回归）', () => {
    const fake = 'v1:' + Buffer.alloc(12 + 4 + 16, 0).toString('base64')
    expect(isCipherText(fake)).toBe(true)
    expect(decryptSecret(fake)).toBe('')
  })

  it('合法密文照常解出（fail-closed 不误伤密文）', () => {
    const ct = encryptSecret('still-readable')
    expect(decryptSecret(ct)).toBe('still-readable')
  })
})

describe('migrateKvSecrets 收尾接线 — 标记落盘 / 撤回 / 不落', () => {
  it('迁移后无明文残留 → 宏任务里落标记', async () => {
    store.set(TG, 'plain-token')
    migrateKvSecrets([TG])
    expect(store.has(PLAINTEXT_MIGRATION_DONE_KEY)).toBe(false) // 同步阶段不落
    await flushTimer()
    expect(store.get(PLAINTEXT_MIGRATION_DONE_KEY)).toBe('1')
    // 且 KV 明文确实被升级成了密文
    expect(isCipherText(store.get(TG)!)).toBe(true)
  })

  it('迁移后 provider 仍有明文残留 → 标记不落（迁移失败不冒充完成）', async () => {
    dbStub.providerRows = [{ v: 'plain-api-key' }]
    migrateKvSecrets([TG])
    await flushTimer()
    expect(store.has(PLAINTEXT_MIGRATION_DONE_KEY)).toBe(false)
  })

  it('迁移后 mcp env/headers 有明文残留 → 标记不落', async () => {
    dbStub.mcpRows = [{ env: '{"API_KEY":"plain"}', headers: null }]
    migrateKvSecrets([TG])
    await flushTimer()
    expect(store.has(PLAINTEXT_MIGRATION_DONE_KEY)).toBe(false)
  })

  it('标记已落但数据回到明文（如合并旧云备份）→ 入口同步撤回标记', () => {
    store.set(PLAINTEXT_MIGRATION_DONE_KEY, '1')
    dbStub.providerRows = [{ v: 'plain-api-key' }]
    migrateKvSecrets([TG])
    expect(store.has(PLAINTEXT_MIGRATION_DONE_KEY)).toBe(false)
  })
})
