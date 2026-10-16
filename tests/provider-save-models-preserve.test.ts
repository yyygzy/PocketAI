// 「空 models」的两种含义不许混为一谈（V4-Iter-151）
//
// 撞出来的现场：首启向导里 OllamaPanel 拉完模型 ⇒ 主进程 `ensureOllamaProvider` 建好/追加了那条 provider
// （`ipc/handlers/ollama.ts:52`），但向导的 provider 清单只在挂载时读过一次（旧快照）⇒
// 用户点「下一步」时向导以为"还没有这条"，发一份 `models: []` 的**新建**载荷，
// 而 `providerRepo.save` 会按 (type, baseUrl) 去重**命中那一行**并把 `[]` 写回去 ⇒ 刚拉到的模型清单被清空。
// 用户看到的是对话页模型栏空掉（V4-Iter-115 那条"挑有模型的 provider"规则紧接着就把他挡在这儿）。
//
// 所以这里守的是**语义边界**，不是"别清空 models"这一句口号：
//  · 不带 id + 去重命中旧行 ⇒ 那份 `[]` 是表单默认值，不是"删到零" ⇒ 保留旧清单；
//  · **带 id** 的 `[]` 才是用户自己删到零（设置页逐个 ✕，115 的合法路径）⇒ 必须仍能清空；
//  · 不带 id 但带着模型名 ⇒ 照旧覆盖（守护不是"永远不动"）。
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

const OLLAMA_URL = 'http://localhost:11434/v1'

function input(over: Partial<SaveInput> = {}): SaveInput {
  return {
    id: '',
    type: 'ollama',
    name: 'Ollama',
    baseUrl: OLLAMA_URL,
    apiKeys: [],
    models: [],
    enabled: true,
    ...over
  } as SaveInput
}

/** 复刻 `ipc/handlers/ollama.ts:12-31`（拉取成功后那条写入），但走真 repo ⇒ 现场是真的 */
function afterPullSucceeded(model: string): string {
  const existing = providerRepo.list().find((p) => p.type === 'ollama' && p.baseUrl.includes('11434'))
  if (existing) {
    if (!existing.models.includes(model)) providerRepo.updateModels(existing.id, [...existing.models, model])
    return existing.id
  }
  return providerRepo.save(
    input({ name: 'Ollama（本地模型）', models: [model] })
  ).id
}

const modelsOf = (id: string): string[] => providerRepo.get(id)?.models ?? []
const rowCount = (): number => providerRepo.list().length

beforeEach(() => {
  mocks.db = new Database(':memory:')
  mocks.db.exec(DDL)
  mocks.mode = 'none'
})

describe('不带 id 的去重命中：空 models 不等于"删到零"', () => {
  it('向导那份载荷（id 空 + models 空）保存后，刚拉到的模型清单仍在', () => {
    const pulledId = afterPullSucceeded('qwen2.5:3b-instruct')
    expect(modelsOf(pulledId)).toEqual(['qwen2.5:3b-instruct'])

    const saved = providerRepo.save(input({ createdAt: Date.now() }))

    // 命中的是同一行（去重照旧生效 ⇒ 不会多出第二条 Ollama）
    expect(saved.id).toBe(pulledId)
    expect(rowCount()).toBe(1)
    expect(modelsOf(pulledId)).toEqual(['qwen2.5:3b-instruct'])
    // 返回的那份也得是落盘终态，否则调用方（向导）会拿着 [] 去决定界面
    expect(saved.models).toEqual(['qwen2.5:3b-instruct'])
  })

  it('反向对照：同一种载荷带着模型名 ⇒ 照旧覆盖（守护不是"永远不动"）', () => {
    const pulledId = afterPullSucceeded('qwen2.5:3b-instruct')
    providerRepo.save(input({ models: ['qwen2.5-coder:1.5b'] }))
    expect(modelsOf(pulledId)).toEqual(['qwen2.5-coder:1.5b'])
  })

  it('守护只看"是不是新建意图"：换个 baseUrl 的同载荷是新建，空清单照写', () => {
    const pulledId = afterPullSucceeded('qwen2.5:3b-instruct')
    const created = providerRepo.save(input({ baseUrl: 'http://localhost:1234/v1', name: 'LM Studio' }))
    expect(created.id).not.toBe(pulledId)
    expect(rowCount()).toBe(2)
    expect(created.models).toEqual([])
    expect(modelsOf(pulledId)).toEqual(['qwen2.5:3b-instruct'])
  })
})

describe('带 id 的保存：115 那条合法路径不能被守护吃掉', () => {
  it('带 id + models: [] ⇒ 仍然清空（用户在设置页把模型逐个删到零）', () => {
    const pulledId = afterPullSucceeded('qwen2.5:3b-instruct')
    const rec = providerRepo.get(pulledId)!
    providerRepo.save(input({ id: rec.id, models: [] }))
    expect(modelsOf(pulledId)).toEqual([])
  })

  it('带 id + 非空 models ⇒ 覆盖成新清单（同一条通道两种方向都对）', () => {
    const pulledId = afterPullSucceeded('qwen2.5:3b-instruct')
    const rec = providerRepo.get(pulledId)!
    providerRepo.save(input({ id: rec.id, models: ['a', 'b'] }))
    expect(modelsOf(pulledId)).toEqual(['a', 'b'])
  })
})
