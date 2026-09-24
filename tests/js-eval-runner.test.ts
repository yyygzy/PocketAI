// js-eval-runner 结果截断函数测试
//
// 覆盖 src/main/sandbox/js-eval-runner.ts 的 cut：
// 结果字符串超长时截断并追加「截断，共 N 字符」后缀，总长度不超过 max。
//
// 策略：cut 为纯函数，mock electron 避免模块加载时 BrowserWindow 不可用。
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))

import { cut } from '../src/main/sandbox/js-eval-runner'

describe('cut — 结果字符串截断', () => {
  it('长度 ≤ max → 原样返回', () => {
    expect(cut('hello', 10)).toBe('hello')
    expect(cut('', 5)).toBe('')
  })

  it('长度正好等于 max → 原样返回（不触发截断）', () => {
    const s = 'abcde'
    expect(cut(s, 5)).toBe(s)
  })

  it('长度 > max → 截断并追加后缀', () => {
    const s = 'a'.repeat(100)
    const max = 20
    const result = cut(s, max)
    // 结果长度不超过 max
    expect(result.length).toBeLessThanOrEqual(max)
    // 包含截断后缀
    expect(result).toContain('（截断，共 100 字符）')
    // 以省略号开头的后缀
    expect(result).toMatch(/\n…（截断，共 100 字符）$/)
  })

  it('截断后结果长度等于 max', () => {
    const s = 'x'.repeat(50)
    const max = 30
    const result = cut(s, max)
    // 后缀长度固定（含 \n… + 数字），数字位数影响后缀长度
    // 50 是两位数，后缀 = "\n…（截断，共 50 字符）" 长度固定
    const suffix = `\n…（截断，共 ${s.length} 字符）`
    const expectedBodyLen = max - suffix.length
    expect(result).toBe('x'.repeat(expectedBodyLen) + suffix)
    expect(result.length).toBe(max)
  })

  it('max 小于后缀长度 → 前缀为空，仅返回后缀', () => {
    const s = 'y'.repeat(100)
    const max = 5 // 远小于后缀长度
    const result = cut(s, max)
    const suffix = `\n…（截断，共 ${s.length} 字符）`
    // Math.max(0, max - suffix.length) = 0，前缀为空
    expect(result).toBe(suffix)
  })

  it('默认 max = 2000（MAX_RESULT_CHARS）', () => {
    // 1999 字符 → 原样返回
    const under = 'a'.repeat(1999)
    expect(cut(under)).toBe(under)
    // 2001 字符 → 触发截断
    const over = 'a'.repeat(2001)
    const result = cut(over)
    expect(result.length).toBeLessThanOrEqual(2000)
    expect(result).toContain('（截断，共 2001 字符）')
  })

  it('后缀计入截断预算，内容被裁短', () => {
    const s = 'Hello World! This is a long string.'
    const max = 30
    const result = cut(s, max)
    const suffix = `\n…（截断，共 ${s.length} 字符）`
    const bodyLen = max - suffix.length
    expect(result).toBe(s.slice(0, bodyLen) + suffix)
    expect(result.length).toBe(max)
  })
})
