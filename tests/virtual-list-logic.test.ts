import { describe, it, expect } from 'vitest'
import { isNearBottom, shouldStickToBottom } from '../src/renderer/src/modules/agent/components/virtual-list-utils'

describe('isNearBottom', () => {
  it('内容不超容器时视为在底部', () => {
    expect(isNearBottom(0, 400, 500)).toBe(true)
    expect(isNearBottom(0, 500, 500)).toBe(true)
  })

  it('在底部锚定区内返回 true', () => {
    // scrollHeight=1000, clientHeight=500，底部差值 = 1000-400-500=100 > 48
    expect(isNearBottom(400, 1000, 500)).toBe(false)
    // scrollTop=452 → 差值 = 1000-452-500=48 <= 48
    expect(isNearBottom(452, 1000, 500)).toBe(true)
    // 顶部时差值=500，不在底部
    expect(isNearBottom(0, 1000, 500)).toBe(false)
  })

  it('差值刚好等于 threshold 返回 true（<= 语义）', () => {
    // 差值 = 48，默认 threshold=48
    expect(isNearBottom(452, 1000, 500)).toBe(true)
  })

  it('差值等于 threshold+1 返回 false', () => {
    // 差值 = 49
    expect(isNearBottom(451, 1000, 500)).toBe(false)
  })

  it('支持自定义 threshold', () => {
    // threshold=100，差值=80 <= 100
    expect(isNearBottom(420, 1000, 500, 100)).toBe(true)
    // 差值=101 > 100
    expect(isNearBottom(399, 1000, 500, 100)).toBe(false)
  })
})

describe('shouldStickToBottom', () => {
  it('非流式时一律不主动滚', () => {
    expect(shouldStickToBottom(true, true, false)).toBe(false)
    expect(shouldStickToBottom(false, false, false)).toBe(false)
    expect(shouldStickToBottom(true, false, false)).toBe(false)
  })

  it('流式中且之前在底部锚定区则跟滚', () => {
    expect(shouldStickToBottom(true, true, true)).toBe(true)
  })

  it('流式中但用户已主动离开底部则不跟滚', () => {
    expect(shouldStickToBottom(false, false, true)).toBe(false)
  })

  it('用历史 wasAtBottom 决策而非瞬时 currentlyNearBottom（避免竞态抖动）', () => {
    // 上一帧在底部（wasAtBottom=true），本次 scroll 瞬间离开（currentlyNearBottom=false），
    // 仍应跟滚一次避免抖动
    expect(shouldStickToBottom(false, true, true)).toBe(true)
    // 上一帧已离开（wasAtBottom=false），本次瞬时回到底部，不主动滚（尊重用户阅读）
    expect(shouldStickToBottom(true, false, true)).toBe(false)
  })
})
