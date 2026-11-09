// 子会话返回锚点：轮次 key 优先、requestId 兜底（纯函数，不涉及滚动/DOM）
import { describe, it, expect } from 'vitest'
import { findTurnIndexByAnchor } from '../src/renderer/src/modules/chat/ChatView'

const turn = (id: string) => ({ items: [{ id }] })

describe('findTurnIndexByAnchor 子会话返回定位', () => {
  const turns = [turn('m1'), turn('m3'), turn('m5')]

  it('按轮次 key 命中', () => {
    expect(findTurnIndexByAnchor(turns, { turnKey: 'm3' })).toBe(1)
  })

  it('key 未命中时按 requestId 兜底', () => {
    const runs = new Map([['m5', { requestId: 'run-xyz' }]])
    expect(findTurnIndexByAnchor(turns, { turnKey: 'gone', requestId: 'run-xyz' }, runs)).toBe(2)
  })

  it('key 命中时不看 requestId', () => {
    const runs = new Map([['m5', { requestId: 'run-xyz' }]])
    expect(findTurnIndexByAnchor(turns, { turnKey: 'm1', requestId: 'run-xyz' }, runs)).toBe(0)
  })

  it('都未命中返回 -1（保持原跳转位置）', () => {
    expect(findTurnIndexByAnchor(turns, { turnKey: 'gone', requestId: 'nope' })).toBe(-1)
    expect(findTurnIndexByAnchor([], { turnKey: 'm1' })).toBe(-1)
  })
})
