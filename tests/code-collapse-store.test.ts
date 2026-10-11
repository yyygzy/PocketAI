// @vitest-environment jsdom
// 渲染端折叠阈值缓存：脏值回落、变更通知订阅者、启动拉取偏好
//
// 这一层是「设置改了立即生效」的唯一载体：Markdown 通过 useSyncExternalStore 订阅它，
// 所以快照函数必须稳定、且值未变化时不能惊动订阅者（否则每次写偏好都全量重渲染）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubPocketai, pocketaiCalls } from './helpers/renderer'
import { CODE_COLLAPSE_THRESHOLD } from '../src/renderer/src/utils/code-block'
import {
  MAX_CODE_COLLAPSE_LINES,
  codeCollapseLines,
  loadCodeCollapseLines,
  normalizeCodeCollapseLines,
  setCodeCollapseLines,
  subscribeCodeCollapse
} from '../src/renderer/src/code-collapse'

beforeEach(() => {
  setCodeCollapseLines(CODE_COLLAPSE_THRESHOLD)
})

describe('normalizeCodeCollapseLines', () => {
  it('0 合法；脏值回落默认 20；超上限压到 200；小数向下取整', () => {
    expect(normalizeCodeCollapseLines(0)).toBe(0)
    expect(normalizeCodeCollapseLines('5')).toBe(5)
    expect(normalizeCodeCollapseLines(null)).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(normalizeCodeCollapseLines(undefined)).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(normalizeCodeCollapseLines('')).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(normalizeCodeCollapseLines('abc')).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(normalizeCodeCollapseLines(-3)).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(normalizeCodeCollapseLines(12.7)).toBe(12)
    expect(normalizeCodeCollapseLines(9999)).toBe(MAX_CODE_COLLAPSE_LINES)
  })
})

describe('阈值快照与订阅', () => {
  it('变更时通知订阅者，取消订阅后不再通知', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCodeCollapse(listener)
    setCodeCollapseLines(5)
    expect(codeCollapseLines()).toBe(5)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    setCodeCollapseLines(9)
    expect(codeCollapseLines()).toBe(9)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('值未变化不通知（脏输入清洗后同值也算未变化）', () => {
    setCodeCollapseLines(8)
    const listener = vi.fn()
    subscribeCodeCollapse(listener)
    setCodeCollapseLines(8)
    setCodeCollapseLines('8')
    setCodeCollapseLines(Number.NaN) // 脏值 -> 默认 20，与当前 8 不同，会通知
    expect(codeCollapseLines()).toBe(CODE_COLLAPSE_THRESHOLD)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('快照函数引用稳定（useSyncExternalStore 每次渲染传同一函数才不会死循环）', () => {
    expect(codeCollapseLines).toBe(codeCollapseLines)
    expect(typeof subscribeCodeCollapse).toBe('function')
  })
})

describe('loadCodeCollapseLines', () => {
  it('启动拉取偏好并落地阈值', async () => {
    stubPocketai({
      getUiPrefs: () => ({ ok: true, data: { codeCollapseLines: 42 } })
    })
    await loadCodeCollapseLines()
    expect(codeCollapseLines()).toBe(42)
    expect(pocketaiCalls().map((c) => c.fn)).toContain('getUiPrefs')
  })

  it('偏好缺失字段按默认处理，不覆盖成 0', async () => {
    stubPocketai({ getUiPrefs: () => ({ ok: true, data: {} }) })
    setCodeCollapseLines(7)
    await loadCodeCollapseLines()
    expect(codeCollapseLines()).toBe(CODE_COLLAPSE_THRESHOLD)
  })

  it('IPC 失败静默：保留当前阈值，不抛出（不能阻断启动）', async () => {
    stubPocketai({ getUiPrefs: () => Promise.reject(new Error('ipc down')) })
    setCodeCollapseLines(3)
    await expect(loadCodeCollapseLines()).resolves.toBeUndefined()
    expect(codeCollapseLines()).toBe(3)
  })
})
