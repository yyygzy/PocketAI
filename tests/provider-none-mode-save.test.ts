// provider apiKeys 上的 B1 闸门（SEC-1 收口：provider 走 B1）
//
// 与 MCP 那条同一口径：未设主密码时字段密钥是源码公开的固定密钥 ⇒ **新 Key 一律拒存**；
// 但掩码往返（只改名/模型/地址）、删除 Key、重新粘贴同一个值、轮换恢复都不得被误伤。
// 用真 sqlite + 真字段加解密跑完整 repo.save，断言落盘终态：被拒时零写入、
// 放行时密文仍能解出原值。注意 repo 层返回的是**明文视图**，掩码只发生在 IPC 出口，
// 所以用例里喂给 save 的「掩码」要自己用 shared/secret-mask 造。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'db',
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
import { maskSecretList } from '../src/shared/secret-mask'
import { decryptApiKeys } from '../src/main/crypto/field-encrypt'
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

function input(over: Partial<SaveInput> = {}): SaveInput {
  return {
    id: '',
    type: 'openai-compatible',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeys: [],
    models: [],
    enabled: true,
    ...over
  } as SaveInput
}

const rowCount = (): number =>
  (mocks.db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n

const rawCipher = (id: string): string =>
  String((mocks.db.prepare('SELECT api_key_encrypted AS v FROM providers WHERE id=?').get(id) as { v: string }).v)

const keysOf = (id: string): string[] => providerRepo.get(id)?.apiKeys ?? []

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'none'
})

describe('none 模式下拒存新 Key', () => {
  it('新增第一条 Key → 拒绝，且库里一行都没有', () => {
    expect(() => providerRepo.save(input({ apiKeys: ['sk-brand-new'] }))).toThrow(/未设置主密码/)
    expect(rowCount()).toBe(0)
  })

  it('拒绝文案只报数量，不回显 Key', () => {
    let msg = ''
    try {
      providerRepo.save(input({ apiKeys: ['sk-secret-1', 'sk-secret-2'] }))
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e)
    }
    expect(msg).toContain('2 个')
    expect(msg).not.toContain('sk-secret-1')
    expect(msg).not.toContain('sk-secret-2')
  })

  it('没有任何 Key（本地模型、只建条目）→ 照常保存', () => {
    const saved = providerRepo.save(input({ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' }))
    expect(saved.apiKeys).toEqual([])
    expect(rowCount()).toBe(1)
  })

  it('给已存在的 provider 追加 Key → 拒绝，原值一字未动', () => {
    mocks.mode = 'db'
    const saved = providerRepo.save(input({ apiKeys: ['sk-old'] }))
    mocks.mode = 'none'
    expect(() =>
      providerRepo.save(input({ id: saved.id, apiKeys: [...saved.apiKeys, 'sk-appended'] }))
    ).toThrow(/未设置主密码/)
    expect(keysOf(saved.id)).toEqual(['sk-old'])
  })

  it('按 (type, baseUrl) 去重命中旧条目时，也以旧条目的真实 Key 为基线', () => {
    mocks.mode = 'db'
    const first = providerRepo.save(input({ apiKeys: ['sk-x-0001'] }))
    mocks.mode = 'none'
    // 同地址、不带 id 再存一个新 Key：existing 来自去重查询 ⇒ 仍应拒，且旧 Key 不变
    expect(() => providerRepo.save(input({ apiKeys: ['sk-y-0002'] }))).toThrow(/未设置主密码/)
    expect(keysOf(first.id)).toEqual(['sk-x-0001'])
  })
})

describe('放行侧：不得误伤已存在的值', () => {
  it('掩码往返（只改名/模型）→ 保存成功且 Key 不变', () => {
    mocks.mode = 'db'
    const saved = providerRepo.save(input({ apiKeys: ['sk-keep-me-1234'] }))
    mocks.mode = 'none'
    const renamed = providerRepo.save(
      input({ id: saved.id, name: '改名了', models: ['deepseek-chat'], apiKeys: maskSecretList(saved.apiKeys) })
    )
    expect(renamed.name).toBe('改名了')
    expect(renamed.models).toEqual(['deepseek-chat'])
    expect(keysOf(saved.id)).toEqual(['sk-keep-me-1234'])
  })

  it('把同一个真实值重新粘贴一遍（不是掩码）→ 也放行：判定按值不按行', () => {
    mocks.mode = 'db'
    const saved = providerRepo.save(input({ apiKeys: ['sk-same-9999'] }))
    mocks.mode = 'none'
    expect(() => providerRepo.save(input({ id: saved.id, apiKeys: ['sk-same-9999'] }))).not.toThrow()
    expect(keysOf(saved.id)).toEqual(['sk-same-9999'])
  })

  it('删除某条 Key → 放行，落盘只剩保留项', () => {
    mocks.mode = 'db'
    const saved = providerRepo.save(input({ apiKeys: ['sk-a-1111', 'sk-b-2222'] }))
    mocks.mode = 'none'
    providerRepo.save(
      input({ id: saved.id, apiKeys: maskSecretList([keysOf(saved.id)[0] ?? '']).concat([]) })
    )
    expect(keysOf(saved.id)).toEqual(['sk-a-1111'])
  })

  it('db 模式下新 Key 正常写入，且落盘确为密文', () => {
    mocks.mode = 'db'
    const saved = providerRepo.save(input({ apiKeys: ['sk-brand-new'] }))
    expect(keysOf(saved.id)).toEqual(['sk-brand-new'])
    expect(rawCipher(saved.id).startsWith('v1:')).toBe(true)
    // decryptApiKeys 已经是「解密 + JSON 解析」后的结果，直接比数组
    expect(decryptApiKeys(rawCipher(saved.id))).toEqual(['sk-brand-new'])
  })
})

describe('轮换通路不受闸门影响（restoreAllApiKeys 不经 save）', () => {
  it('明文模式下仍可恢复快照', () => {
    const saved = providerRepo.save(input({ apiKeys: [] }))
    expect(() => providerRepo.restoreAllApiKeys({ [saved.id]: ['sk-rotated-back'] })).not.toThrow()
    expect(keysOf(saved.id)).toEqual(['sk-rotated-back'])
  })
})
