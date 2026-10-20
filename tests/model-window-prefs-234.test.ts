// @vitest-environment node
// 每台模型「上下文窗口」的存储层（V4-Iter-234）
//
// 这一层的全部风险都在"写进去的键与值，读出来还是不是同一个"：
// 键错了 ⇒ 引擎永远匹配不上（用户设了窗口却没生效，界面上还是一句"未设"）；
// 值脏了没被清 ⇒ 引擎拿一个 0 或 5,000,000 去算预算，历史被裁成一轮或干脆撑爆端点。
// 形状沿用同族的 text-protocol-prefs：桩掉 appConfigRepo（内存 Map），不建新表。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    writes: [] as string[]
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => mocks.store.get(k) ?? null,
    set: (k: string, v: string) => {
      mocks.writes.push(k)
      mocks.store.set(k, v)
    }
  }
}))

import {
  getModelContextWindow,
  listModelContextWindows,
  normalizeModelWindows,
  setModelContextWindow
} from '../src/main/agent/model-window-prefs'
import {
  MODEL_WINDOW_MAX_ENTRIES,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS,
  modelWindowKey
} from '../src/shared/model-window'

const K = 'agent.model_context_windows'

beforeEach(() => {
  mocks.store.clear()
  mocks.writes.length = 0
})

describe('未设就是未设，不是 0、也不是空表', () => {
  it('空库：表是空的，单查返回 null（引擎据此退回"最近 30 条"那条老路）', () => {
    expect(listModelContextWindows()).toEqual({})
    expect(getModelContextWindow('p1', 'm1')).toBeNull()
  })

  it('往返：设进去的数原样读回来，键是 providerId::model', () => {
    const r = setModelContextWindow('p1', 'glm-4.6', 8192)
    expect(r.rejected).toBeUndefined()
    expect(r.windows[modelWindowKey('p1', 'glm-4.6')]).toBe(8192)
    expect(getModelContextWindow('p1', 'glm-4.6')).toBe(8192)
    expect(JSON.parse(mocks.store.get(K) ?? '{}')).toEqual({ 'p1::glm-4.6': 8192 })
  })

  it('同值重复设 ⇒ 不重写库（幂等，省下一次无谓的写）', () => {
    setModelContextWindow('p1', 'm1', 8192)
    mocks.writes.length = 0
    const again = setModelContextWindow('p1', 'm1', 8192)
    expect(again.rejected).toBeUndefined()
    expect(mocks.writes, '没变化却写了一次库').toEqual([])
  })
})

describe('拒绝的那一支：不写库，且只回码', () => {
  it.each([
    ['低于下限', MODEL_WINDOW_MIN_TOKENS - 1],
    ['高于上限', MODEL_WINDOW_MAX_TOKENS + 1],
    ['小数', 8192.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])('%s 的值被拒（%p）', (_what, value) => {
    const r = setModelContextWindow('p1', 'm1', value)
    expect(r.rejected).toBe('MODEL_WINDOW_INVALID_VALUE')
    expect(mocks.writes, '被拒的值却写进库了').toEqual([])
    expect(getModelContextWindow('p1', 'm1')).toBeNull()
  })

  it('边界上的两个值都收（下限与上限本身合法）', () => {
    expect(setModelContextWindow('p1', 'min', MODEL_WINDOW_MIN_TOKENS).rejected).toBeUndefined()
    expect(setModelContextWindow('p1', 'max', MODEL_WINDOW_MAX_TOKENS).rejected).toBeUndefined()
  })

  it.each([
    ['空 providerId', '', 'm1'],
    ['空 model', 'p1', ''],
    ['providerId 含分隔符（键会解析成别的形状）', 'p1::x', 'm1'],
    ['model 超长', 'p1', 'm'.repeat(200)]
  ])('非法 id ⇒ INVALID_ID 且不写库：%s', (_what, providerId, model) => {
    const r = setModelContextWindow(providerId, model, 8192)
    expect(r.rejected).toBe('MODEL_WINDOW_INVALID_ID')
    expect(mocks.writes).toEqual([])
  })
})

describe('清除', () => {
  it('设过了再清 ⇒ 条目消失并写库', () => {
    setModelContextWindow('p1', 'm1', 8192)
    const r = setModelContextWindow('p1', 'm1', null)
    expect(r.windows).toEqual({})
    expect(getModelContextWindow('p1', 'm1')).toBeNull()
    expect(mocks.store.get(K)).toBe('{}')
  })

  it('没设过时点清除 ⇒ 不写库（不是"清除失败"，本来就没什么可清）', () => {
    const r = setModelContextWindow('p1', 'm1', null)
    expect(r.rejected).toBeUndefined()
    expect(mocks.writes).toEqual([])
  })
})

describe('清洗：库里的脏值不能变成引擎的输入', () => {
  it.each([
    ['坏 JSON', 'not json'],
    ['数组而不是对象', '["p1::m1"]'],
    ['null', 'null'],
    ['字符串', '"8192"']
  ])('%s ⇒ 整表当空（不抛错，也不留下半个表）', (_what, raw) => {
    mocks.store.set(K, raw)
    expect(listModelContextWindows()).toEqual({})
    expect(getModelContextWindow('p1', 'm1')).toBeNull()
  })

  it('逐条剔：键缺半边／值是字符串／值越界，都不进表；同表里的合法项照样留下', () => {
    mocks.store.set(
      K,
      JSON.stringify({
        'p1::': 8192,
        '::m1': 8192,
        'p2::m2': '8192',
        'p3::m3': 5,
        'p4::m4': MODEL_WINDOW_MAX_TOKENS + 1,
        'p5::m5': 32_000,
        'p6::m6': 1024.5
      })
    )
    expect(listModelContextWindows()).toEqual({ 'p5::m5': 32_000 })
  })

  it('条目上限：超出 MAX_ENTRIES 的项被截掉（脏值不能把 KV 无限撑大）', () => {
    const many: Record<string, number> = {}
    for (let i = 0; i < MODEL_WINDOW_MAX_ENTRIES + 50; i++) many[`p::m${i}`] = 4096
    mocks.store.set(K, JSON.stringify(many))
    expect(Object.keys(listModelContextWindows())).toHaveLength(MODEL_WINDOW_MAX_ENTRIES)
  })

  it('normalizeModelWindows 收到 undefined／数字也不抛（服务层之外的调用方也得安全）', () => {
    expect(normalizeModelWindows(undefined)).toEqual({})
    expect(normalizeModelWindows(42)).toEqual({})
  })
})
