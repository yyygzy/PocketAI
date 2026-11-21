// mustGet 断言函数测试
//
// 覆盖 src/main/db/must-get.ts 的 mustGet：
// 命中返回值、undefined/null 抛错且错误信息含 label、falsy 但非空值透传。
// 纯函数，零 mock。
import { describe, it, expect } from 'vitest'

import { mustGet } from '../src/main/db/must-get'

describe('mustGet — 断言 getter 非空', () => {
  it('getter 返回对象 → 原样返回', () => {
    const row = { id: 'r1', name: '记录' }
    expect(mustGet(() => row, '记录')).toBe(row)
  })

  it('getter 返回 undefined → 抛错且错误信息含 label', () => {
    expect(() => mustGet(() => undefined, '会话'))
    .toThrowError('会话 不存在或已被删除')
  })

  it('getter 返回 null → 同样抛错（DB 查询不存在行时 better-sqlite3 返回 undefined，null 防御手动传入）', () => {
    expect(() => mustGet(() => null, '消息')).toThrowError('消息 不存在或已被删除')
  })

  it('falsy 但非空值原样透传（0 / 空串 / false 是合法记录值）', () => {
    expect(mustGet(() => 0, '零')).toBe(0)
    expect(mustGet(() => '', '空串')).toBe('')
    expect(mustGet(() => false, '假')).toBe(false)
  })

  it('错误信息未命中时不抛错（正常路径无副作用）', () => {
    const calls: number[] = []
    const v = mustGet(() => {
      calls.push(1)
      return 42
    }, '数字')
    expect(v).toBe(42)
    expect(calls).toHaveLength(1) // getter 只执行一次
  })
})
