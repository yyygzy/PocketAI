// Provider 管理器测试
//
// 覆盖 src/main/providers/manager.ts 的 ProviderManager：
// - getAdapter：缓存命中 / 无记录抛错 / 禁用抛错 / 构造参数（normalizeBaseUrl + apiKeys + anthropic 标记）/ 缓存失效重建
// - getRecord：存在 / 不存在抛错
// - fetchModels：listModels 写回 DB 缓存并 invalidate / 上游抛错传播
// - test：成功 {ok,modelCount} / 失败 {ok,error}
// - invalidate：删单个 / 清空全部
//
// 策略：vi.mock providerRepo（Map 存储）与 OpenAICompatibleAdapter（记录构造参数），
// normalizeBaseUrl 走真实实现以验证入参规范化。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { providerManager } from '../src/main/providers/manager'
import type { ProviderRecord } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  records: new Map<string, ProviderRecord>(),
  // OpenAICompatibleAdapter 构造参数记录
  constructed: [] as Array<{ baseUrl: string; apiKeys: string[]; anthropic: boolean }>,
  // adapter.listModels 行为
  listModels: [] as string[],
  listModelsError: null as Error | null,
  // providerRepo.updateModels 调用记录
  updatedModels: [] as Array<{ id: string; models: string[] }>,
  getCalls: 0,
  reset() {
    this.records.clear()
    this.constructed = []
    this.listModels = []
    this.listModelsError = null
    this.updatedModels = []
    this.getCalls = 0
  }
}))

function makeRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'p1',
    type: 'openai-compatible',
    name: '测试渠道',
    baseUrl: 'http://localhost:11434',
    apiKeys: ['k1', 'k2'],
    models: [],
    enabled: true,
    createdAt: 1,
    ...overrides
  }
}

vi.mock('../src/main/db/repositories/provider.repo', () => ({
  providerRepo: {
    get: (id: string) => {
      mocks.getCalls++
      return mocks.records.get(id) ?? null
    },
    updateModels: (id: string, models: string[]) => {
      mocks.updatedModels.push({ id, models })
    }
  }
}))

vi.mock('../src/main/providers/openai-compatible', () => ({
  OpenAICompatibleAdapter: class MockAdapter {
    baseUrl: string
    apiKeys: string[]
    anthropic: boolean
    constructor(baseUrl: string, apiKeys: string[], anthropic: boolean) {
      this.baseUrl = baseUrl
      this.apiKeys = apiKeys
      this.anthropic = anthropic
      mocks.constructed.push({ baseUrl, apiKeys, anthropic })
    }
    async listModels(): Promise<string[]> {
      if (mocks.listModelsError) throw mocks.listModelsError
      return mocks.listModels
    }
  }
}))

beforeEach(() => {
  mocks.reset()
  providerManager.invalidate()
})

// ---------- getAdapter ----------

describe('getAdapter 适配器获取与缓存', () => {
  it('正常创建：构造参数为规范化 baseUrl + apiKeys + 非 anthropic', () => {
    mocks.records.set('p1', makeRecord({ baseUrl: 'http://localhost:11434/' }))
    const a = providerManager.getAdapter('p1')
    expect(a).toBeTruthy()
    expect(mocks.constructed).toEqual([
      { baseUrl: 'http://localhost:11434/v1', apiKeys: ['k1', 'k2'], anthropic: false }
    ])
  })

  it('anthropic 类型：构造第三参为 true（启用 prompt caching）', () => {
    mocks.records.set('p1', makeRecord({ type: 'anthropic' as ProviderRecord['type'] }))
    providerManager.getAdapter('p1')
    expect(mocks.constructed[0]!.anthropic).toBe(true)
  })

  it('缓存命中：二次调用同实例且不再查 repo', () => {
    mocks.records.set('p1', makeRecord())
    const a1 = providerManager.getAdapter('p1')
    const a2 = providerManager.getAdapter('p1')
    expect(a1).toBe(a2)
    expect(mocks.constructed).toHaveLength(1)
    expect(mocks.getCalls).toBe(1)
  })

  it('Provider 不存在：抛错并带 id', () => {
    expect(() => providerManager.getAdapter('nope')).toThrow('Provider 不存在: nope')
  })

  it('Provider 已禁用：抛错并带名称', () => {
    mocks.records.set('p1', makeRecord({ enabled: false, name: '停用渠道' }))
    expect(() => providerManager.getAdapter('p1')).toThrow('Provider 已禁用: 停用渠道')
  })

  it('invalidate(id) 后重建：新实例且重新查 repo', () => {
    mocks.records.set('p1', makeRecord())
    const a1 = providerManager.getAdapter('p1')
    providerManager.invalidate('p1')
    const a2 = providerManager.getAdapter('p1')
    expect(a1).not.toBe(a2)
    expect(mocks.constructed).toHaveLength(2)
    expect(mocks.getCalls).toBe(2)
  })
})

// ---------- getRecord ----------

describe('getRecord 记录查询', () => {
  it('存在：原样返回记录', () => {
    const rec = makeRecord({ id: 'r1', name: 'R1' })
    mocks.records.set('r1', rec)
    expect(providerManager.getRecord('r1')).toBe(rec)
  })

  it('不存在：抛错并带 id', () => {
    expect(() => providerManager.getRecord('ghost')).toThrow('Provider 不存在: ghost')
  })
})

// ---------- fetchModels ----------

describe('fetchModels 模型列表拉取', () => {
  it('正常：拉取结果写回 DB 缓存并 invalidate，返回列表', async () => {
    mocks.records.set('p1', makeRecord())
    mocks.listModels = ['m1', 'm2', 'm3']
    const models = await providerManager.fetchModels('p1')
    expect(models).toEqual(['m1', 'm2', 'm3'])
    expect(mocks.updatedModels).toEqual([{ id: 'p1', models: ['m1', 'm2', 'm3'] }])
    // invalidate 后再次 getAdapter 会重建
    providerManager.getAdapter('p1')
    expect(mocks.constructed).toHaveLength(2)
  })

  it('上游抛错（Provider 不存在）：传播给调用方', async () => {
    await expect(providerManager.fetchModels('nope')).rejects.toThrow('Provider 不存在: nope')
    expect(mocks.updatedModels).toEqual([])
  })
})

// ---------- test ----------

describe('test 连通性测试', () => {
  it('成功：{ok:true, modelCount}', async () => {
    mocks.records.set('p1', makeRecord())
    mocks.listModels = ['a', 'b']
    const r = await providerManager.test('p1')
    expect(r).toEqual({ ok: true, modelCount: 2 })
  })

  it('失败：{ok:false, error} 不抛错', async () => {
    mocks.records.set('p1', makeRecord())
    mocks.listModelsError = new Error('连接被拒绝')
    const r = await providerManager.test('p1')
    expect(r).toEqual({ ok: false, error: '连接被拒绝' })
  })

  it('Provider 不存在：同样返回 {ok:false, error}', async () => {
    const r = await providerManager.test('ghost')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Provider 不存在')
  })
})

// ---------- invalidate ----------

describe('invalidate 缓存失效', () => {
  it('无参调用：清空全部缓存', () => {
    mocks.records.set('p1', makeRecord())
    mocks.records.set('p2', makeRecord({ id: 'p2' }))
    providerManager.getAdapter('p1')
    providerManager.getAdapter('p2')
    expect(mocks.constructed).toHaveLength(2)
    providerManager.invalidate()
    providerManager.getAdapter('p1')
    providerManager.getAdapter('p2')
    expect(mocks.constructed).toHaveLength(4)
  })

  it('失效后 getAdapter 抛错场景：缓存已删，重新查 repo 触发禁用错误', () => {
    mocks.records.set('p1', makeRecord())
    providerManager.getAdapter('p1')
    mocks.records.set('p1', makeRecord({ enabled: false }))
    providerManager.invalidate('p1')
    // 缓存已删 → 重新走 repo → 命中新状态（禁用）抛错
    expect(() => providerManager.getAdapter('p1')).toThrow('Provider 已禁用')
  })
})
