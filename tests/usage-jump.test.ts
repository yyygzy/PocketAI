// usage-jump 纯函数测试：pending 存取/读后即清/非法数据容错
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { requestUsageJump, consumePendingUsageJump } from '../src/renderer/src/modules/settings/usage-jump'

const createMockStorage = () => {
  let store: Record<string, string> = {}
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { store = {} }
  }
}

beforeEach(() => {
  const mock = createMockStorage()
  vi.stubGlobal('sessionStorage', mock)
  // window 仅在浏览器环境存在；测试 stub 防 ReferenceError
  vi.stubGlobal('window', { dispatchEvent: () => {} })
})

describe('usage-jump — request/consume', () => {
  it('request 写入 pending，consume 读出并清空', () => {
    requestUsageJump({ type: 'conversation', convId: 'c1' })
    expect(sessionStorage.getItem('usage-pending-jump')).toBeTruthy()
    expect(consumePendingUsageJump()).toEqual({ type: 'conversation', convId: 'c1' })
    // 读后即清
    expect(consumePendingUsageJump()).toBeNull()
  })

  it('assistant 类型正常存取', () => {
    requestUsageJump({ type: 'assistant', assistantId: 'a1' })
    expect(consumePendingUsageJump()).toEqual({ type: 'assistant', assistantId: 'a1' })
  })

  it('非法 JSON 返回 null 并清除', () => {
    sessionStorage.setItem('usage-pending-jump', 'not-json')
    expect(consumePendingUsageJump()).toBeNull()
    expect(sessionStorage.getItem('usage-pending-jump')).toBeNull()
  })

  it('type 字段非法返回 null', () => {
    sessionStorage.setItem('usage-pending-jump', JSON.stringify({ type: 'unknown', id: 'x' }))
    expect(consumePendingUsageJump()).toBeNull()
  })

  it('conversation 缺 convId 返回 null', () => {
    sessionStorage.setItem('usage-pending-jump', JSON.stringify({ type: 'conversation' }))
    expect(consumePendingUsageJump()).toBeNull()
  })

  it('无 pending 时返回 null', () => {
    expect(consumePendingUsageJump()).toBeNull()
  })
})
