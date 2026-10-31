// @vitest-environment node
// V4-Iter-375（旗舰 #1：解密失败 ≠ 无凭据）行为用例。
//
// 承重的不是 decryptSecret 本身（那是 field-encrypt.test.ts 的地盘），而是三个轮换导出器
// 在「有密文却解不开」时**不再把它当『没配过』悄悄跳过**：解不开的行不进明文快照（跳过重写、
// 原密文留在原地），但必须单列进 undecryptable，交给 credential-rotation 如实上报。
//
// 制造解不开：伪造一个 v1: 密文（iv/tag/体全零 ⇒ AES-GCM setAuthTag/final 抛 ⇒ decryptSecret catch→''）。
// 正向对照：合法密文（真加密）／历史明文（非 v1:，原样返回）→ 进 snapshot、不进 undecryptable；
// 反向对照：列本身为 null（真没配）→ 两处都不进。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const FIELD_KEY = Buffer.alloc(32, 0x41)
// 合法 apiKeys／secretMap 用真加密（getFieldKey 被 mock 成 FIELD_KEY，加解密同一把）
const BOGUS_CIPHER = 'v1:' + Buffer.alloc(12 + 4 + 16, 0).toString('base64')

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getFieldKey: () => FIELD_KEY }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() })
}))

// dbService 桩：prepare(sql).all() 返回按 SQL 前缀取到的原始行；.run/.get 供其余路径兜底
let providerRows: { id: string; api_key_encrypted: string | null }[] = []
let mcpRows: { id: string; env: string | null; headers: string | null }[] = []
vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('FROM providers') ? providerRows : mcpRows),
        get: () => undefined,
        run: () => {}
      })
    })
  }
}))

import { encryptApiKeys, encryptSecretMap } from '../src/main/crypto/field-encrypt'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'

beforeEach(() => {
  providerRows = []
  mcpRows = []
})

describe('providerRepo.exportAllApiKeys — 解不开的行分栏（§375）', () => {
  it('合法密文进 snapshot、历史明文进 snapshot、坏密文进 undecryptable、null 两处都不进', () => {
    providerRows = [
      { id: 'p-good', api_key_encrypted: encryptApiKeys(['sk-a', 'sk-b']) },
      { id: 'p-plain', api_key_encrypted: JSON.stringify(['sk-legacy']) }, // 非 v1: 明文，向后兼容
      { id: 'p-broken', api_key_encrypted: BOGUS_CIPHER }, // 有密文解不开
      { id: 'p-none', api_key_encrypted: null } // 真没配
    ]
    const { snapshot, undecryptable } = providerRepo.exportAllApiKeys()
    expect(snapshot).toEqual({ 'p-good': ['sk-a', 'sk-b'], 'p-plain': ['sk-legacy'] })
    expect(undecryptable).toEqual(['p-broken'])
  })

  it('反向对照：全都是合法/明文 ⇒ undecryptable 为空（不误报）', () => {
    providerRows = [{ id: 'p-good', api_key_encrypted: encryptApiKeys(['sk']) }]
    const { snapshot, undecryptable } = providerRepo.exportAllApiKeys()
    expect(Object.keys(snapshot)).toEqual(['p-good'])
    expect(undecryptable).toEqual([])
  })

  it('空 apiKeys 存的是空串（不是密文）⇒ 算「没配」两处都不进，绝不因 length===0 被误当解不开', () => {
    providerRows = [{ id: 'p-empty', api_key_encrypted: '' }]
    const { snapshot, undecryptable } = providerRepo.exportAllApiKeys()
    expect(snapshot).toEqual({})
    expect(undecryptable).toEqual([])
  })
})

describe('mcpServerRepo.exportAllSecrets — 解不开的行分栏（§375）', () => {
  it('env 是坏密文 ⇒ 该行进 undecryptable；合法 env 进 snapshot；两列皆空串＝没配不进', () => {
    mcpRows = [
      { id: 's-good', env: encryptSecretMap({ API_KEY: 'k' }), headers: '' },
      { id: 's-broken-env', env: BOGUS_CIPHER, headers: '' },
      { id: 's-broken-hdr', env: '', headers: BOGUS_CIPHER },
      { id: 's-none', env: '', headers: '' }
    ]
    const { snapshot, undecryptable } = mcpServerRepo.exportAllSecrets()
    expect(snapshot).toEqual({ 's-good': { env: { API_KEY: 'k' }, headers: {} } })
    expect(undecryptable.sort()).toEqual(['s-broken-env', 's-broken-hdr'])
  })
})
