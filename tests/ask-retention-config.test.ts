// ask-retention-config 测试
//
// 覆盖 src/main/knowledge/ask-retention-config.ts：
// parseKbAskRetention 容错解析（坏输入回退双 0 关闭态）与 get/set KV 读写。
//
// 策略：mock appConfigRepo 为内存 KV。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: { value: undefined as string | undefined }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => (key === 'kbAsk.retention' ? store.value : undefined),
    set: (key: string, value: string) => {
      if (key === 'kbAsk.retention') store.value = value
    }
  }
}))

import {
  getKbAskRetention,
  setKbAskRetention,
  parseKbAskRetention
} from '../src/main/knowledge/ask-retention-config'

beforeEach(() => {
  store.value = undefined
})

describe('parseKbAskRetention — 容错解析', () => {
  it('非对象输入 → 回退关闭态', () => {
    expect(parseKbAskRetention(null)).toEqual({ keepCount: 0, keepDays: 0 })
    expect(parseKbAskRetention('x')).toEqual({ keepCount: 0, keepDays: 0 })
    expect(parseKbAskRetention(42)).toEqual({ keepCount: 0, keepDays: 0 })
  })

  it('非法字段值（负数/NaN/字符串）→ 该项回退 0', () => {
    expect(parseKbAskRetention({ keepCount: -5, keepDays: NaN })).toEqual({ keepCount: 0, keepDays: 0 })
    expect(parseKbAskRetention({ keepCount: 'abc', keepDays: 30 })).toEqual({ keepCount: 0, keepDays: 30 })
  })

  it('合法值保留，小数向下取整', () => {
    expect(parseKbAskRetention({ keepCount: 100, keepDays: 30 })).toEqual({ keepCount: 100, keepDays: 30 })
    expect(parseKbAskRetention({ keepCount: 99.9 })).toEqual({ keepCount: 99, keepDays: 0 })
  })
})

describe('getKbAskRetention / setKbAskRetention — KV 读写', () => {
  it('无配置 → 回退关闭态', () => {
    expect(getKbAskRetention()).toEqual({ keepCount: 0, keepDays: 0 })
  })

  it('坏 JSON → 回退关闭态', () => {
    store.value = 'not-json'
    expect(getKbAskRetention()).toEqual({ keepCount: 0, keepDays: 0 })
  })

  it('set 后 get 读回一致', () => {
    setKbAskRetention({ keepCount: 200, keepDays: 90 })
    expect(getKbAskRetention()).toEqual({ keepCount: 200, keepDays: 90 })
  })
})
