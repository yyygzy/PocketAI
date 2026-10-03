// input-history 纯函数与存储容错测试（localStorage 用内存 stub 注入）
import { describe, it, expect } from 'vitest'
import { appendHistory, loadHistory, pushHistory, INPUT_HISTORY_KEY, INPUT_HISTORY_MAX } from '../src/renderer/src/utils/input-history'

/** 内存 localStorage stub */
function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    map
  }
}

describe('appendHistory — 追加规则', () => {
  it('空串/纯空白不收', () => {
    expect(appendHistory([], '')).toEqual([])
    expect(appendHistory([], '   ')).toEqual([])
  })

  it('与最新一条相同 → 跳过（终端去重惯例）', () => {
    expect(appendHistory(['a'], 'a')).toEqual(['a'])
    expect(appendHistory(['a'], ' a ')).toEqual(['a']) // trim 后相同
  })

  it('正常追加 trim 后的值', () => {
    expect(appendHistory(['a'], '  b  ')).toEqual(['a', 'b'])
  })

  it('超过上限 → 丢最旧保留最新（环形）', () => {
    const full = Array.from({ length: INPUT_HISTORY_MAX }, (_, i) => `m${i}`)
    const next = appendHistory(full, 'new')
    expect(next).toHaveLength(INPUT_HISTORY_MAX)
    expect(next[0]).toBe('m1') // m0 被挤出
    expect(next[next.length - 1]).toBe('new')
  })
})

describe('loadHistory — 存储容错', () => {
  it('无 key → 空数组', () => {
    expect(loadHistory(memStorage())).toEqual([])
  })

  it('坏 JSON → 空数组', () => {
    expect(loadHistory(memStorage({ [INPUT_HISTORY_KEY]: '{broken' }))).toEqual([])
  })

  it('非数组/含非字符串项 → 过滤', () => {
    expect(loadHistory(memStorage({ [INPUT_HISTORY_KEY]: '"just-a-string"' }))).toEqual([])
    expect(loadHistory(memStorage({ [INPUT_HISTORY_KEY]: '["a", 1, " ", null, "b"]' }))).toEqual(['a', 'b'])
  })
})

describe('pushHistory — 读写回环', () => {
  it('追加并持久化，再读回同值', () => {
    const s = memStorage()
    pushHistory('第一条', s)
    pushHistory('第二条', s)
    expect(loadHistory(s)).toEqual(['第一条', '第二条'])
    // 持久化内容确实是 JSON 数组
    expect(JSON.parse(s.map.get(INPUT_HISTORY_KEY)!)).toEqual(['第一条', '第二条'])
  })

  it('setItem 抛错（存储满）→ 不抛出，返回内存结果', () => {
    const s = memStorage()
    const broken = { getItem: s.getItem, setItem: () => { throw new Error('quota') } }
    expect(() => pushHistory('x', broken)).not.toThrow()
  })
})
