// builtin safeMathEval 安全数学表达式求值测试
//
// 覆盖 src/main/tools/builtin.ts 的 safeMathEval：
// 白名单标识符 + vm 沙箱，防止任意代码执行（RCE）。
//
// 策略：safeMathEval 仅依赖 node:vm + errMsg，但 builtin.ts 顶层 import 重依赖
// （websearch/js-eval-runner/safe-fetch/weather/calendar-ics/kb-search→db 链），全部 mock 掉。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/tools/websearch', () => ({ runWebSearch: async () => '' }))
vi.mock('../src/main/sandbox/js-eval-runner', () => ({ runJsEval: async () => '' }))
vi.mock('../src/main/net/safe-fetch', () => ({ safeFetch: async () => ({ status: 200, body: Buffer.alloc(0) }) }))
vi.mock('../src/main/tools/weather', () => ({ weatherTool: {} }))
vi.mock('../src/main/tools/calendar-ics', () => ({ calendarReadTool: {} }))
vi.mock('../src/main/tools/kb-search', () => ({ kbSearchTool: {} }))
vi.mock('../src/main/tools/todo-write', () => ({ todoWriteTool: {} }))
vi.mock('../src/main/tools/memory-save', () => ({ memorySaveTool: {} }))

import { safeMathEval } from '../src/main/tools/builtin'

describe('safeMathEval — 安全数学表达式求值', () => {
  // ── 正常值 ──────────────────────────────────────────────
  it('基本四则运算', () => {
    expect(safeMathEval('1 + 2')).toBe(3)
    expect(safeMathEval('10 - 3')).toBe(7)
    expect(safeMathEval('4 * 5')).toBe(20)
    expect(safeMathEval('15 / 3')).toBe(5)
  })

  it('运算符优先级与括号', () => {
    expect(safeMathEval('2 + 3 * 4')).toBe(14)
    expect(safeMathEval('(2 + 3) * 4')).toBe(20)
  })

  it('取模 %', () => {
    expect(safeMathEval('10 % 3')).toBe(1)
  })

  it('小数运算', () => {
    expect(safeMathEval('1.5 + 2.5')).toBe(4)
    expect(safeMathEval('0.1 * 10')).toBeCloseTo(1)
  })

  it('科学计数法', () => {
    expect(safeMathEval('1.5e3')).toBe(1500)
    expect(safeMathEval('1e-2')).toBe(0.01)
  })

  it('白名单函数', () => {
    expect(safeMathEval('abs(-5)')).toBe(5)
    expect(safeMathEval('sqrt(16)')).toBe(4)
    expect(safeMathEval('round(3.7)')).toBe(4)
    expect(safeMathEval('floor(3.9)')).toBe(3)
    expect(safeMathEval('ceil(3.1)')).toBe(4)
    expect(safeMathEval('min(1,2,3)')).toBe(1)
    expect(safeMathEval('max(1,2,3)')).toBe(3)
  })

  it('三角函数', () => {
    expect(safeMathEval('sin(0)')).toBe(0)
    expect(safeMathEval('cos(0)')).toBe(1)
  })

  it('常量 PI / E', () => {
    expect(safeMathEval('PI')).toBeCloseTo(Math.PI)
    expect(safeMathEval('E')).toBeCloseTo(Math.E)
  })

  it('复合表达式', () => {
    expect(safeMathEval('sqrt(abs(-16)) + round(2.5)')).toBe(7)
  })

  // ── 安全边界 ────────────────────────────────────────────
  it('超过 500 字符 → 抛错', () => {
    const long = '1+'.repeat(251) + '1'
    expect(() => safeMathEval(long)).toThrow('上限 500')
  })

  it('非法字符 → 抛错', () => {
    expect(() => safeMathEval('1 + "hello"')).toThrow('非法字符')
    expect(() => safeMathEval('1; 2')).toThrow('非法字符')
    expect(() => safeMathEval('1 = 2')).toThrow('非法字符')
  })

  it('非白名单标识符 → 抛错', () => {
    expect(() => safeMathEval('process')).toThrow('不允许的标识符')
    expect(() => safeMathEval('process.exit(0)')).toThrow('不允许的标识符')
    expect(() => safeMathEval('globalThis')).toThrow('不允许的标识符')
    expect(() => safeMathEval('eval("1")')).toThrow()
  })

  it('除零 → Infinity → 结果非有限 → 抛错', () => {
    expect(() => safeMathEval('1 / 0')).toThrow()
  })

  it('负数开方 → NaN → 结果非有限 → 抛错', () => {
    expect(() => safeMathEval('sqrt(-1)')).toThrow()
  })

  it('空串 → 解析失败抛错', () => {
    expect(() => safeMathEval('')).toThrow()
  })
})
