// 来源跳转导航测试：requestSourceJump / consumePendingSourceJump
// （node 环境无 sessionStorage，mock 简单 Map 存储）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
})

const dispatched: string[] = []
vi.stubGlobal('window', {
  dispatchEvent: (e: Event) => void dispatched.push(e.type)
})

import { requestSourceJump, consumePendingSourceJump } from '../src/renderer/src/modules/knowledge/source-jump'

beforeEach(() => {
  store.clear()
  dispatched.length = 0
})

describe('requestSourceJump — 发起跳转', () => {
  it('写入 pending + 广播模块切换与 KB 事件', () => {
    requestSourceJump({ kbId: 'kb1', docId: 'd1', seq: 3 })
    expect(store.get('kb-pending-source')).toBe(JSON.stringify({ kbId: 'kb1', docId: 'd1', seq: 3 }))
    expect(dispatched).toEqual(['pocketai:switch-module', 'kb-open-source'])
  })
})

describe('consumePendingSourceJump — 消费 pending', () => {
  it('读后即清，返回结构化参数', () => {
    store.set('kb-pending-source', JSON.stringify({ kbId: 'kb1', docId: 'd1', seq: 3 }))
    expect(consumePendingSourceJump()).toEqual({ kbId: 'kb1', docId: 'd1', seq: 3 })
    expect(store.has('kb-pending-source')).toBe(false)
    // 二次消费为空
    expect(consumePendingSourceJump()).toBeNull()
  })

  it('坏 JSON / 字段缺失返回 null 且清除 pending', () => {
    store.set('kb-pending-source', '{bad json')
    expect(consumePendingSourceJump()).toBeNull()
    expect(store.has('kb-pending-source')).toBe(false)

    store.set('kb-pending-source', JSON.stringify({ kbId: 'kb1' }))
    expect(consumePendingSourceJump()).toBeNull()
    expect(store.has('kb-pending-source')).toBe(false)
  })

  it('无 pending 返回 null', () => {
    expect(consumePendingSourceJump()).toBeNull()
  })
})
