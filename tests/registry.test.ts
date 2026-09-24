// registry 工具策略判定与 MCP 结果解析测试
//
// 覆盖 src/main/tools/registry.ts 的三个纯工具函数：
// - stricterDecision：两个 ToolClassification 取更严者（deny > confirm > allow）
// - mcpResultIsError：从 unknown 形状安全提取 isError 标志
// - stringifyMcpResult：MCP 结果序列化为字符串（string / content[] / JSON / 降级）
//
// 策略：纯函数无运行时依赖，但 registry.ts 顶层 import BUILTIN_TOOLS/mcpManager，
// 需 mock 掉避免重依赖链初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/tools/builtin', () => ({
  BUILTIN_TOOLS: [],
  ToolDecision: {}
}))
vi.mock('../src/main/tools/fs-tools', () => ({ getFsTools: () => [] }))
vi.mock('../src/main/tools/shell-tools', () => ({ getShellTools: () => [] }))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listMcpTools: () => [], callTool: async () => ({ isError: false }) }
}))

import {
  stricterDecision,
  mcpResultIsError,
  stringifyMcpResult
} from '../src/main/tools/registry'
import type { ToolClassification } from '../src/main/tools/builtin'

describe('stricterDecision — 取更严判定（deny > confirm > allow）', () => {
  it('allow + confirm → confirm', () => {
    const a: ToolClassification = { decision: 'allow' }
    const b: ToolClassification = { decision: 'confirm', reason: 'NEED_CONFIRM' }
    expect(stricterDecision(a, b)).toEqual(b)
  })

  it('confirm + deny → deny', () => {
    const a: ToolClassification = { decision: 'confirm', reason: 'A' }
    const b: ToolClassification = { decision: 'deny', reason: 'DANGEROUS' }
    expect(stricterDecision(a, b)).toEqual(b)
  })

  it('allow + deny → deny', () => {
    const a: ToolClassification = { decision: 'allow' }
    const b: ToolClassification = { decision: 'deny', reason: 'X' }
    expect(stricterDecision(a, b)).toEqual(b)
  })

  it('同级别 → 返回第一个参数 a（b 不比 a 严）', () => {
    const a: ToolClassification = { decision: 'confirm', reason: 'A' }
    const b: ToolClassification = { decision: 'confirm', reason: 'B' }
    expect(stricterDecision(a, b)).toEqual(a)
  })

  it('b 比 a 松 → 返回 a', () => {
    const a: ToolClassification = { decision: 'deny', reason: 'A' }
    const b: ToolClassification = { decision: 'allow' }
    expect(stricterDecision(a, b)).toEqual(a)
  })

  it('reason 随更严结果', () => {
    const a: ToolClassification = { decision: 'allow' }
    const b: ToolClassification = { decision: 'deny', reason: 'SHELL_DISABLED' }
    expect(stricterDecision(a, b).reason).toBe('SHELL_DISABLED')
  })
})

describe('mcpResultIsError — 从 unknown 安全提取 isError', () => {
  it('{ isError: true } → true', () => {
    expect(mcpResultIsError({ isError: true })).toBe(true)
  })

  it('{ isError: false } → false', () => {
    expect(mcpResultIsError({ isError: false })).toBe(false)
  })

  it('{ isError: 1 }（truthy）→ true', () => {
    expect(mcpResultIsError({ isError: 1 })).toBe(true)
  })

  it('{ isError: 0 }（falsy）→ false', () => {
    expect(mcpResultIsError({ isError: 0 })).toBe(false)
  })

  it('无 isError 字段 → false', () => {
    expect(mcpResultIsError({ content: [] })).toBe(false)
  })

  it('非对象 → false', () => {
    expect(mcpResultIsError(null)).toBe(false)
    expect(mcpResultIsError(undefined)).toBe(false)
    expect(mcpResultIsError('error')).toBe(false)
    expect(mcpResultIsError(42)).toBe(false)
    expect(mcpResultIsError(true)).toBe(false)
  })

  it('数组（typeof 是 object）但无 isError → false', () => {
    expect(mcpResultIsError([1, 2, 3])).toBe(false)
  })
})

describe('stringifyMcpResult — MCP 结果序列化为字符串', () => {
  it('字符串 → 原样返回', () => {
    expect(stringifyMcpResult('hello')).toBe('hello')
  })

  it('content 数组中 text 项 → 用换行拼接', () => {
    const raw = {
      content: [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' }
      ]
    }
    expect(stringifyMcpResult(raw)).toBe('line1\nline2')
  })

  it('content 数组中非 text 项 → JSON.stringify 该项', () => {
    const raw = {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'base64' }
      ]
    }
    expect(stringifyMcpResult(raw)).toBe('hello\n{"type":"image","data":"base64"}')
  })

  it('content 数组中 text 为空串 → 走 JSON.stringify 分支', () => {
    const raw = { content: [{ type: 'text', text: '' }] }
    // text 为空串时 `c.text ? c.text : JSON.stringify(c)` → JSON.stringify(c)
    expect(stringifyMcpResult(raw)).toBe('{"type":"text","text":""}')
  })

  it('普通对象 → JSON.stringify', () => {
    expect(stringifyMcpResult({ foo: 'bar', num: 42 })).toBe('{"foo":"bar","num":42}')
  })

  it('数字 → JSON.stringify', () => {
    expect(stringifyMcpResult(42)).toBe('42')
  })

  it('null → JSON.stringify → "null"', () => {
    expect(stringifyMcpResult(null)).toBe('null')
  })

  it('数组 → JSON.stringify', () => {
    expect(stringifyMcpResult([1, 2, 3])).toBe('[1,2,3]')
  })

  it('BigInt 等无法 JSON.stringify → 降级 String()', () => {
    // BigInt 在 JSON.stringify 中抛 TypeError，降级为 String
    const raw = { value: 123n }
    expect(stringifyMcpResult(raw)).toBe(String(raw))
  })
})
