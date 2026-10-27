// V4-Iter-328：同一把 API Key 不许在库里存两遍
//
// 现场在首启向导：`FirstRunWizard.tsx` 那条「已有同 baseUrl 就追加这把 Key」的载荷是
// `[...existing.apiKeys, apiKey]`，而界面上看得见的 `existing.apiKeys` 是**掩码串**（SEC-7：列表不出明文）。
// 于是"在不在里面"这件事在渲染层永远判不出来（明文 ≠ 掩码），中途失败后再点一次「下一步」
// 就会把同一把 Key 追第二遍；`restoreMaskedList` 只按下标还原掩码项，也不去重。
// ⇒ 收口只能落在**还原成真实值的那一刻**（本文件这条 repo 侧），这也是所有调用方共用的那一道门。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  mode: 'db' as 'none' | 'db',
  key: Buffer.alloc(32, 5),
  db: null as unknown as Database.Database
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.mode,
    getFieldKey: () => mocks.key,
    hasKey: () => true,
    isDbEncrypted: () => mocks.mode === 'db'
  }
}))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => mocks.db } }))

import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { maskSecret } from '../src/shared/secret-mask'
import type { ProviderRecord } from '../src/shared/types'

type SaveInput = Omit<ProviderRecord, 'createdAt'> & { createdAt?: number }

const DDL = `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT,
    models TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`

const input = (over: Partial<SaveInput> = {}): SaveInput => ({
  id: '',
  type: 'openai-compatible',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  apiKeys: [],
  models: ['gpt-4o'],
  enabled: true,
  ...over
})

const keysOf = (id: string): string[] => providerRepo.get(id)?.apiKeys ?? []

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'db'
})

describe('328 密钥去重落在还原之后', () => {
  it('向导重试那条：掩码位还原成原值后与追加的明文同源 ⇒ 库里只留一把', () => {
    const created = providerRepo.save(input({ apiKeys: ['sk-real-abcd'] }))
    expect(keysOf(created.id)).toEqual(['sk-real-abcd'])

    // 渲染层看得见的是掩码串，追加的是明文——这正是界面上 `includes` 判不出来的那一份载荷
    providerRepo.save(input({ id: created.id, apiKeys: [maskSecret('sk-real-abcd'), 'sk-real-abcd'] }))

    expect(keysOf(created.id), '同一把 Key 存两遍没有任何合法含义').toEqual(['sk-real-abcd'])
  })

  it('反向对照：两把不同的 Key 都留下、顺序不动（去重不是"只留第一把"）', () => {
    const created = providerRepo.save(input({ apiKeys: ['sk-one-1111'] }))
    providerRepo.save(
      input({ id: created.id, apiKeys: [maskSecret('sk-one-1111'), 'sk-two-2222'] })
    )
    expect(keysOf(created.id)).toEqual(['sk-one-1111', 'sk-two-2222'])
  })

  it('一发里就带着两条同样的明文 ⇒ 同样折成一条（入口不止向导那一条）', () => {
    const created = providerRepo.save(input({ apiKeys: ['sk-dup-9999', 'sk-dup-9999'] }))
    expect(keysOf(created.id)).toEqual(['sk-dup-9999'])
  })
})
