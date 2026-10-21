// @vitest-environment node
// §236 MCP 注解：边界收回来 + 只用来把确认收紧。
//
// 这批最容易把安全性"改松"的地方就在这——所以判据的形状是：
//  · 正向：destructiveHint / openWorldHint 为 true ⇒ 即便 trustReadOnly、名字又是只读前缀，也留 confirm；
//  · **反向**：readOnlyHint 单独出现绝不升 auto（升 auto 的只有词表那一档，注解不参与放宽）；
//  · 反向：一条注解都没有时，结果与改动前逐条相同（这批不许有任何静默收紧）。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/mcp/json-rpc', () => ({ StdioJsonRpcClient: class {} }))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({ mcpServerRepo: {} }))
vi.mock('../src/main/portable', () => ({ MCP_EXTENSIONS_DIR: '/mock/ext/mcp' }))
vi.mock('../src/main/mcp/python-env', () => ({
  pythonEnvService: {},
  venvPython: '',
  venvDir: '',
  venvBinDir: ''
}))
vi.mock('../src/main/logger', () => ({ createLogger: () => ({}) }))

import { classifyMcpToolPermission, normalizeMcpAnnotations } from '../src/main/mcp/manager'
import { describeMcpAnnotations } from '../src/shared/mcp-annotations'

describe('normalizeMcpAnnotations：外部边界上不假设形状', () => {
  it('五个已知字段按类型收，未知键与非布尔值丢掉', () => {
    const a = normalizeMcpAnnotations({
      title: '  查资料  ',
      readOnlyHint: true,
      destructiveHint: 'yes',
      openWorldHint: false,
      serverSideOnly: { nested: true },
      idempotentHint: 1
    })
    expect(a).toEqual({ title: '查资料', readOnlyHint: true, openWorldHint: false })
  })

  it('非对象（含数组）/全空 ⇒ undefined，而不是一个空壳', () => {
    expect(normalizeMcpAnnotations(null)).toBeUndefined()
    expect(normalizeMcpAnnotations(['readOnlyHint'])).toBeUndefined()
    expect(normalizeMcpAnnotations({ unknown: true })).toBeUndefined()
  })

  it('title 超长被截到 120 字符（这一串是给界面看的，不是给模型的）', () => {
    const a = normalizeMcpAnnotations({ title: 'x'.repeat(400) })
    expect(a!.title!.length).toBe(120)
  })
})

describe('classifyMcpToolPermission 的二次分级', () => {
  const READONLY_NAME = 'get_status'

  it('正向：自称 destructive / openWorld 的工具，即便被信任也不免确认', () => {
    expect(classifyMcpToolPermission(READONLY_NAME, true, { destructiveHint: true })).toBe('confirm')
    expect(classifyMcpToolPermission(READONLY_NAME, true, { openWorldHint: true })).toBe('confirm')
    // 只有 false 不算申报危险
    expect(classifyMcpToolPermission(READONLY_NAME, true, { destructiveHint: false })).toBe('auto')
  })

  it('反向（这条是口径本身）：readOnlyHint 绝不替工具打开 auto', () => {
    // 名字不在词表里 ⇒ 没有注解时 confirm，带 readOnlyHint 还是 confirm
    expect(classifyMcpToolPermission('weird_tool_name', true)).toBe('confirm')
    expect(classifyMcpToolPermission('weird_tool_name', true, { readOnlyHint: true })).toBe('confirm')
    expect(classifyMcpToolPermission('weird_tool_name', true, { readOnlyHint: true, idempotentHint: true })).toBe(
      'confirm'
    )
  })

  it('反向：一条注解都没有时，判定与改动前逐条相同（这批没有静默收紧）', () => {
    const noAnn = ['get_status', 'list_files', 'delete_row', 'do_the_thing'].map((n) =>
      classifyMcpToolPermission(n, true)
    )
    const withUndefined = ['get_status', 'list_files', 'delete_row', 'do_the_thing'].map((n) =>
      classifyMcpToolPermission(n, true, undefined)
    )
    expect(withUndefined).toEqual(noAnn)
    expect(noAnn).toEqual(['auto', 'auto', 'confirm', 'confirm'])
  })

  it('不信任该 Server 时，无论注解说什么都是 confirm', () => {
    expect(classifyMcpToolPermission(READONLY_NAME, false, { readOnlyHint: true })).toBe('confirm')
    expect(classifyMcpToolPermission(READONLY_NAME, false, { destructiveHint: true })).toBe('confirm')
  })
})

describe('界面那一串（describeMcpAnnotations）', () => {
  it('只列它为真的那几项', () => {
    expect(describeMcpAnnotations({ readOnlyHint: true, destructiveHint: false })).toBe('readOnly')
    expect(describeMcpAnnotations({ destructiveHint: true, openWorldHint: true })).toBe('destructive, openWorld')
  })

  it('只给了 title 时不报成"没声明任何东西"', () => {
    expect(describeMcpAnnotations({ title: '查资料' })).toBe('title')
  })
})
