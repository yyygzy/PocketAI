// providers.enabled_models 三态语义与写入规则（模型启用与两级选择方案 P1）
//
//  · NULL / 坏 JSON ⇒ 未配置，全部 models 启用（老库升级零感知；坏数据降级为 null 不是 []）；
//  · [] ⇒ 明确全部停用；
//  · ["a"] ⇒ 白名单，读取时与 models 求交集、顺序跟 models 走。
// 写入：undefined 保留旧值；null 写 NULL；数组与最终 models 求交集；
// 去重命中（不带 id）时 [] 保留旧启用集，带 id 才允许清空；
// updateModels（重新拉取）不动启用集；deduplicate 合并启用集。
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
import { enabledModelsOf } from '../src/shared/provider-models'
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
    enabled_models TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`

const URL = 'http://localhost:11434/v1'

function input(over: Partial<SaveInput> = {}): SaveInput {
  return {
    id: '',
    type: 'ollama',
    name: 'Ollama',
    baseUrl: URL,
    apiKeys: [],
    models: [],
    enabled: true,
    ...over
  } as SaveInput
}

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'none'
})

describe('三态读取', () => {
  it('新建 provider 默认 NULL：enabledModelsOf 返回全部 models', () => {
    const id = providerRepo.save(input({ models: ['a', 'b'] })).id
    const rec = providerRepo.get(id)!
    expect(rec.enabledModels).toBeNull()
    expect(enabledModelsOf(rec)).toEqual(['a', 'b'])
  })

  it('显式 []：全部停用', () => {
    const id = providerRepo.save(input({ models: ['a', 'b'], enabledModels: [] })).id
    expect(enabledModelsOf(providerRepo.get(id)!)).toEqual([])
  })

  it('显式白名单：与 models 求交集，顺序跟 models 走，裁剪失效项', () => {
    const id = providerRepo.save(input({ models: ['a', 'b', 'c'], enabledModels: ['c', 'ghost', 'a', 'a'] })).id
    expect(enabledModelsOf(providerRepo.get(id)!)).toEqual(['a', 'c'])
  })

  it('坏 JSON 降级为 null（全部启用），不是 []', () => {
    const id = providerRepo.save(input({ models: ['a', 'b'] })).id
    mocks.db.prepare('UPDATE providers SET enabled_models=? WHERE id=?').run('{broken', id)
    const rec = providerRepo.get(id)!
    expect(rec.enabledModels).toBeNull()
    expect(enabledModelsOf(rec)).toEqual(['a', 'b'])
  })
})

function setup(models: string[] = ['a', 'b'], enabledModels?: string[] | null): string {
  return providerRepo
    .save(input({ models, ...(enabledModels !== undefined ? { enabledModels } : {}) }))
    .id
}

describe('save 写入语义', () => {
  it('undefined：保留旧启用集（首启向导等调用方不误清空）', () => {
    const id = setup(['a', 'b'], ['b'])
    providerRepo.save(input({ id, models: ['a', 'b', 'c'] }))
    expect(providerRepo.get(id)!.enabledModels).toEqual(['b'])
  })

  it('undefined + 新建：写 NULL', () => {
    const id = providerRepo.save(input({ models: ['a'] })).id
    expect(providerRepo.get(id)!.enabledModels).toBeNull()
  })

  it('null：显式写回「未配置」', () => {
    const id = setup(['a', 'b'], ['b'])
    providerRepo.save(input({ id, models: ['a', 'b'], enabledModels: null }))
    expect(providerRepo.get(id)!.enabledModels).toBeNull()
  })

  it('数组：与最终 models 求交集落库', () => {
    const id = setup(['a', 'b'], ['b'])
    providerRepo.save(input({ id, models: ['a', 'b', 'c'], enabledModels: ['c', 'b'] }))
    expect(providerRepo.get(id)!.enabledModels).toEqual(['b', 'c'])
  })

  it('不带 id + 去重命中 + enabledModels: [] ⇒ 保留旧启用集（新建意图误伤守护）', () => {
    const id = setup(['a', 'b'], ['b'])
    const saved = providerRepo.save(input({ models: ['a', 'b'], enabledModels: [] }))
    expect(saved.id).toBe(id)
    expect(providerRepo.get(id)!.enabledModels).toEqual(['b'])
  })

  it('不带 id + 去重命中 + enabledModels 非空 ⇒ 照写（守护不是「永远不动」）', () => {
    const id = setup(['a', 'b'], ['b'])
    providerRepo.save(input({ models: ['a', 'b'], enabledModels: ['a'] }))
    expect(providerRepo.get(id)!.enabledModels).toEqual(['a'])
  })

  it('带 id + enabledModels: [] ⇒ 允许清空（用户在设置页全部停用）', () => {
    const id = setup(['a', 'b'], ['b'])
    providerRepo.save(input({ id, models: ['a', 'b'], enabledModels: [] }))
    expect(providerRepo.get(id)!.enabledModels).toEqual([])
  })
})

describe('拉取与去重', () => {
  it('updateModels（重新拉取）不动启用集：NULL 保持 NULL，显式白名单保留（新模型默认不启用）', () => {
    const idNull = setup(['a'], undefined)
    providerRepo.updateModels(idNull, ['a', 'new'])
    expect(providerRepo.get(idNull)!.enabledModels).toBeNull()
    expect(enabledModelsOf(providerRepo.get(idNull)!)).toEqual(['a', 'new'])

    // 不同 baseUrl，避免被 save 的 (type, baseUrl) 去重命中同一行
    const idExplicit = providerRepo
      .save(input({ baseUrl: 'http://localhost:1234/v1', models: ['a'], enabledModels: ['a'] }))
      .id
    providerRepo.updateModels(idExplicit, ['a', 'new'])
    expect(providerRepo.get(idExplicit)!.enabledModels).toEqual(['a'])
    expect(enabledModelsOf(providerRepo.get(idExplicit)!)).toEqual(['a'])
  })

  // save() 自带 (type, baseUrl) 去重，造真重复行需绕开它：先落一条，再直接 SQL 插第二条
  const insertDup = (models: string, enabledModels: string | null): void => {
    mocks.db
      .prepare(
        `INSERT INTO providers (id, type, name, base_url, api_key_encrypted, models, enabled_models, enabled, created_at)
         VALUES ('dup-row', 'ollama', 'Ollama 2', ?, NULL, ?, ?, 1, ?)`
      )
      .run(URL, models, enabledModels, Date.now())
  }

  it('deduplicate：双方 NULL ⇒ NULL', () => {
    const n1 = setup(['a'], undefined)
    insertDup('["b"]', null)
    providerRepo.deduplicate()
    const merged = providerRepo.get(n1)!
    expect(providerRepo.list()).toHaveLength(1)
    expect(merged.enabledModels).toBeNull()
    expect(merged.models).toEqual(['a', 'b'])
  })

  it('deduplicate：survivor 显式 [] + dup NULL ⇒ 合并后只剩 NULL 方的 models', () => {
    const s1 = setup(['x'], [])
    insertDup('["y"]', null)
    providerRepo.deduplicate()
    const merged = providerRepo.get(s1)!
    expect(providerRepo.list()).toHaveLength(1)
    expect(merged.models).toEqual(['x', 'y'])
    expect(merged.enabledModels).toEqual(['y'])
  })

  it('deduplicate：survivor NULL + dup 显式 ⇒ NULL 方按全部 models 计', () => {
    const t1 = setup(['x'], undefined)
    insertDup('["y"]', '["y"]')
    providerRepo.deduplicate()
    const merged = providerRepo.get(t1)!
    expect(providerRepo.list()).toHaveLength(1)
    expect(merged.enabledModels).toEqual(['x', 'y'])
  })
})
