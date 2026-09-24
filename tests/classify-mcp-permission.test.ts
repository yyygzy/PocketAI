// classifyMcpToolPermission MCP 工具权限分类测试
//
// 覆盖 src/main/mcp/manager.ts 的 classifyMcpToolPermission：
// - 命中危险关键词 → 'confirm'
// - 只读前缀 → 'auto'
// - 未知语义 → 'confirm'（保守）
//
// 策略：mock 掉 mcp/manager 的重依赖（json-rpc / repo / python-env / logger / portable），
// 直接测试纯函数 classifyMcpToolPermission。
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

import { classifyMcpToolPermission } from '../src/main/mcp/manager'

describe('classifyMcpToolPermission — MCP 工具权限分类', () => {
  // ── 危险关键词 → confirm ───────────────────────────────
  it('含 delete → confirm', () => {
    expect(classifyMcpToolPermission('delete_file')).toBe('confirm')
  })

  it('含 exec → confirm', () => {
    expect(classifyMcpToolPermission('exec_command')).toBe('confirm')
  })

  it('含 execute → confirm', () => {
    expect(classifyMcpToolPermission('execute_script')).toBe('confirm')
  })

  it('含 write → confirm', () => {
    expect(classifyMcpToolPermission('write_file')).toBe('confirm')
  })

  it('含 install → confirm', () => {
    expect(classifyMcpToolPermission('install_package')).toBe('confirm')
  })

  it('含 sudo → confirm', () => {
    expect(classifyMcpToolPermission('sudo_run')).toBe('confirm')
  })

  it('含 eval → confirm', () => {
    expect(classifyMcpToolPermission('eval_code')).toBe('confirm')
  })

  it('危险关键词不区分大小写 → confirm', () => {
    expect(classifyMcpToolPermission('DeleteFile')).toBe('confirm')
    expect(classifyMcpToolPermission('EXEC_CMD')).toBe('confirm')
  })

  it('即使前缀是只读但含危险词 → confirm（危险优先）', () => {
    // get_delete 以 get 开头（只读）但含 delete（危险）
    expect(classifyMcpToolPermission('get_delete_log')).toBe('confirm')
  })

  // ── 只读前缀 → auto ────────────────────────────────────
  it('get 前缀 → auto', () => {
    expect(classifyMcpToolPermission('get_user')).toBe('auto')
  })

  it('list 前缀 → auto', () => {
    expect(classifyMcpToolPermission('list_files')).toBe('auto')
  })

  it('read 前缀 → auto', () => {
    expect(classifyMcpToolPermission('read_doc')).toBe('auto')
  })

  it('search 前缀 → auto', () => {
    expect(classifyMcpToolPermission('search_web')).toBe('auto')
  })

  it('query 前缀 → auto', () => {
    expect(classifyMcpToolPermission('query_db')).toBe('auto')
  })

  it('describe 前缀 → auto', () => {
    expect(classifyMcpToolPermission('describe_table')).toBe('auto')
  })

  it('info 前缀 → auto', () => {
    expect(classifyMcpToolPermission('info_status')).toBe('auto')
  })

  it('只读前缀不区分大小写 → auto', () => {
    expect(classifyMcpToolPermission('GetUser')).toBe('auto')
    expect(classifyMcpToolPermission('LIST_FILES')).toBe('auto')
  })

  // ── 未知语义 → confirm（保守）──────────────────────────
  it('未知工具名 → confirm（保守）', () => {
    expect(classifyMcpToolPermission('do_something')).toBe('confirm')
  })

  it('空串 → confirm', () => {
    expect(classifyMcpToolPermission('')).toBe('confirm')
  })

  it('null/undefined → confirm', () => {
    expect(classifyMcpToolPermission(null as unknown as string)).toBe('confirm')
    expect(classifyMcpToolPermission(undefined as unknown as string)).toBe('confirm')
  })

  it('只有数字 → confirm', () => {
    expect(classifyMcpToolPermission('123')).toBe('confirm')
  })
})
