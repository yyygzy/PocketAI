// 模型级「走文本协议」开关的存储层（§4.4-⑦）
//
// 这个开关是"用户点名才降级"的那一半（另一半是端点报 400 时的自动切换），
// 所以它的正确性全在键的形态与清洗上：写进去的必须是 `providerId::model`，
// 脏值不能污染清单（否则 isTextProtocolForced 会永久 miss，用户点了开关却没生效）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k)
    },
    writes: [] as string[]
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => mocks.appConfigRepo.get(k),
    set: (k: string, v: string) => {
      mocks.writes.push(k)
      mocks.appConfigRepo.set(k, v)
    }
  }
}))

import {
  MAX_TEXT_PROTOCOL_MODELS,
  isTextProtocolForced,
  listTextProtocolModels,
  normalizeTextProtocolModels,
  setTextProtocolModel,
  textProtocolKey
} from '../src/main/agent/text-protocol-prefs'

const K = 'agent.text_protocol_models'

beforeEach(() => {
  mocks.store.clear()
  mocks.writes.length = 0
})

describe('textProtocolKey / normalizeTextProtocolModels', () => {
  it('键形如 providerId::model（与用量单价表同形，用户可对照）', () => {
    expect(textProtocolKey('p1', 'glm-4.6')).toBe('p1::glm-4.6')
  })

  it('去首尾空白、去重、保持顺序', () => {
    expect(normalizeTextProtocolModels([' p1 :: m1 ', 'p1::m1', 'p2::m2'])).toEqual(['p1::m1', 'p2::m2'])
  })

  it('缺 provider 或缺 model 的项丢掉（:: 开头/结尾/只有分隔符都不算合法键）', () => {
    expect(normalizeTextProtocolModels(['::m1', 'p1::', '::', 'no-separator', ''])).toEqual([])
  })

  it('非字符串项与超长片段丢掉（脏值不污染清单，也不撑大 KV）', () => {
    expect(normalizeTextProtocolModels([42, null, { a: 1 }, ['p1::m1']])).toEqual([])
    expect(normalizeTextProtocolModels([`p1::${'m'.repeat(200)}x`])).toEqual([])
    expect(normalizeTextProtocolModels([`${'p'.repeat(200)}::m1`])).toEqual([])
  })

  it('条数封顶：超上限只留前面的（防脏 KV 无限增长）', () => {
    const many = Array.from({ length: MAX_TEXT_PROTOCOL_MODELS + 30 }, (_, i) => `p::m${i}`)
    expect(normalizeTextProtocolModels(many)).toHaveLength(MAX_TEXT_PROTOCOL_MODELS)
  })

  it('非数组输入 → 空列表而不是抛', () => {
    expect(normalizeTextProtocolModels(undefined)).toEqual([])
    expect(normalizeTextProtocolModels('p1::m1')).toEqual([])
  })
})

describe('读写通道', () => {
  it('库里没有记录 → 空清单；脏 JSON → 空清单（不抛）', () => {
    expect(listTextProtocolModels()).toEqual([])
    mocks.store.set(K, '{not json')
    expect(listTextProtocolModels()).toEqual([])
  })

  it('脏记录读出来即被清洗（isTextProtocolForced 不会因为多了空段而误判）', () => {
    mocks.store.set(K, JSON.stringify(['p1::m1', '::bad', 'p2 :: m2 ']))
    expect(listTextProtocolModels()).toEqual(['p1::m1', 'p2::m2'])
    expect(isTextProtocolForced('p2', 'm2')).toBe(true)
  })

  it('开 → 写库并返回最新清单；再开同一台是幂等的（不多写一次）', () => {
    expect(setTextProtocolModel('p1', 'm1', true)).toEqual(['p1::m1'])
    expect(mocks.writes).toEqual([K])
    expect(setTextProtocolModel('p1', 'm1', true)).toEqual(['p1::m1'])
    expect(mocks.writes).toHaveLength(1)
  })

  it('关 → 只移除那一条，其余保留', () => {
    setTextProtocolModel('p1', 'm1', true)
    setTextProtocolModel('p2', 'm2', true)
    expect(setTextProtocolModel('p1', 'm1', false)).toEqual(['p2::m2'])
    expect(isTextProtocolForced('p1', 'm1')).toBe(false)
    expect(isTextProtocolForced('p2', 'm2')).toBe(true)
  })

  it('空 providerId / 空 model 视为非法：不写库、返回当前清单', () => {
    setTextProtocolModel('p1', 'm1', true)
    expect(setTextProtocolModel('', 'm2', true)).toEqual(['p1::m1'])
    expect(setTextProtocolModel('p2', '   ', true)).toEqual(['p1::m1'])
    expect(mocks.writes).toHaveLength(1)
  })

  it('providerId 自身含 :: 时拒绝（键会解析成别的形状，往返不一致）', () => {
    setTextProtocolModel('p1', 'm1', true)
    expect(setTextProtocolModel('evil::p', 'm2', true)).toEqual(['p1::m1'])
    expect(mocks.writes).toHaveLength(1)
  })

  it('isTextProtocolForced 对空参数一律 false（未选模型时不该命中任何记录）', () => {
    setTextProtocolModel('p1', 'm1', true)
    expect(isTextProtocolForced('', 'm1')).toBe(false)
    expect(isTextProtocolForced('p1', '')).toBe(false)
  })
})
