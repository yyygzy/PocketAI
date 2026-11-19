// @vitest-environment node
// 工具参数执行前校验（v78 第 4 批）
//
// 目标：把"缺必填 / 类型不对 / JSON 非法"变成模型看得懂、能自行修正的结构化错误；
// 同时保持宽松——schema 没声明的类型不拦，本来能跑通的调用不能被挡在门外。
import { describe, expect, it } from 'vitest'
import { validateToolArguments } from '../src/main/agent/tool-args-validate'
import type { ToolSchema } from '../src/shared/types'

function schema(partial: {
  properties?: Record<string, { type?: string }>
  required?: string[]
}): ToolSchema {
  return {
    id: 'demo.x',
    name: 'demo_x',
    description: '演示',
    parameters: { type: 'object', ...partial },
    source: 'builtin',
    permission: 'auto'
  }
}

describe('validateToolArguments — JSON 形态', () => {
  it('非法 JSON → 明确报错（不静默当 {} 执行）', () => {
    const r = validateToolArguments(schema({}), '{"location": "北京"')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不是合法 JSON')
  })

  it('数组/标量 → 报"必须是 JSON 对象"', () => {
    expect(validateToolArguments(schema({}), '["a"]').ok).toBe(false)
    expect(validateToolArguments(schema({}), '"abc"').ok).toBe(false)
  })

  it('空字符串参数按 {} 处理（无必填时通过）', () => {
    expect(validateToolArguments(schema({}), '').ok).toBe(true)
  })
})

describe('validateToolArguments — 必填与类型', () => {
  it('缺必填 → 报字段名与期望类型', () => {
    const s = schema({ properties: { location: { type: 'string' } }, required: ['location'] })
    const r = validateToolArguments(s, '{}')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('location')
    expect(r.error).toContain('string')
  })

  it('必填为空串同样视为缺失（避免下游报"xxx 不能为空"）', () => {
    const s = schema({ properties: { query: { type: 'string' } }, required: ['query'] })
    expect(validateToolArguments(s, '{"query":"  "}').ok).toBe(false)
  })

  it('类型不匹配 → 报实际类型', () => {
    const s = schema({ properties: { days: { type: 'number' } } })
    const r = validateToolArguments(s, '{"days":"3"}')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('days')
    expect(r.error).toContain('number')
    expect(r.error).toContain('string')
  })

  it('合法整数/布尔/数组通过', () => {
    const s = schema({
      properties: { days: { type: 'integer' }, flag: { type: 'boolean' }, items: { type: 'array' } }
    })
    expect(validateToolArguments(s, '{"days":3,"flag":true,"items":[1,2]}').ok).toBe(true)
  })
})

describe('validateToolArguments — 宽松边界', () => {
  it('schema 未声明类型 → 不拦（enum/oneOf 等交给工具自身）', () => {
    const s = schema({ properties: { mode: {} } })
    expect(validateToolArguments(s, '{"mode":"deep"}').ok).toBe(true)
  })

  it('可选字段未提供 → 通过', () => {
    const s = schema({ properties: { target: { type: 'string' } } })
    expect(validateToolArguments(s, '{"base":"USD"}').ok).toBe(true)
  })

  it('没有 schema（未知/MCP 未注册）→ 只校验 JSON 形态', () => {
    expect(validateToolArguments(null, '{"anything":1}').ok).toBe(true)
    expect(validateToolArguments(undefined, '{bad').ok).toBe(false)
  })
})
