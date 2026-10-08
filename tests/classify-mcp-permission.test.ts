// classifyMcpToolPermission MCP 工具权限分类测试
//
// 覆盖 src/main/mcp/manager.ts 的 classifyMcpToolPermission（SEC-5 改造后）：
// - 默认（未信任该 Server）→ 一律 'confirm'，只读命名也不例外（名字由 Server 自报，不可信）
// - 显式信任（trustReadOnly=true）后才走名称语义：危险关键词 'confirm'、只读前缀 'auto'、未知 'confirm'
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

const TRUSTED = true

describe('classifyMcpToolPermission — 默认不信任：一律需确认', () => {
  it('只读命名在无显式信任时也是 confirm（绕过路径已封死）', () => {
    for (const name of ['get_user', 'list_files', 'read_doc', 'search_web', 'query_db', 'status']) {
      expect(classifyMcpToolPermission(name), name).toBe('confirm')
    }
  })

  it('显式传 false 与缺省等价', () => {
    expect(classifyMcpToolPermission('get_user', false)).toBe('confirm')
  })
})

describe('classifyMcpToolPermission — 显式信任后的名称分级', () => {
  // ── 危险关键词 → confirm ───────────────────────────────
  it('含 delete → confirm', () => {
    expect(classifyMcpToolPermission('delete_file', TRUSTED)).toBe('confirm')
  })

  it('含 exec → confirm', () => {
    expect(classifyMcpToolPermission('exec_command', TRUSTED)).toBe('confirm')
  })

  it('含 execute → confirm', () => {
    expect(classifyMcpToolPermission('execute_script', TRUSTED)).toBe('confirm')
  })

  it('含 write → confirm', () => {
    expect(classifyMcpToolPermission('write_file', TRUSTED)).toBe('confirm')
  })

  it('含 install → confirm', () => {
    expect(classifyMcpToolPermission('install_package', TRUSTED)).toBe('confirm')
  })

  it('含 sudo → confirm', () => {
    expect(classifyMcpToolPermission('sudo_run', TRUSTED)).toBe('confirm')
  })

  it('含 eval → confirm', () => {
    expect(classifyMcpToolPermission('eval_code', TRUSTED)).toBe('confirm')
  })

  it('危险关键词不区分大小写 → confirm', () => {
    expect(classifyMcpToolPermission('DeleteFile', TRUSTED)).toBe('confirm')
    expect(classifyMcpToolPermission('EXEC_CMD', TRUSTED)).toBe('confirm')
  })

  it('即使前缀是只读但含危险词 → confirm（危险优先）', () => {
    // get_delete 以 get 开头（只读）但含 delete（危险）
    expect(classifyMcpToolPermission('get_delete_log', TRUSTED)).toBe('confirm')
  })

  // ── 只读前缀 → auto ────────────────────────────────────
  it('get 前缀 → auto', () => {
    expect(classifyMcpToolPermission('get_user', TRUSTED)).toBe('auto')
  })

  it('list 前缀 → auto', () => {
    expect(classifyMcpToolPermission('list_files', TRUSTED)).toBe('auto')
  })

  it('read 前缀 → auto', () => {
    expect(classifyMcpToolPermission('read_doc', TRUSTED)).toBe('auto')
  })

  it('search 前缀 → auto', () => {
    expect(classifyMcpToolPermission('search_web', TRUSTED)).toBe('auto')
  })

  it('query 前缀 → auto', () => {
    expect(classifyMcpToolPermission('query_db', TRUSTED)).toBe('auto')
  })

  it('describe 前缀 → auto', () => {
    expect(classifyMcpToolPermission('describe_table', TRUSTED)).toBe('auto')
  })

  it('info 前缀 → auto', () => {
    expect(classifyMcpToolPermission('info_status', TRUSTED)).toBe('auto')
  })

  it('只读前缀不区分大小写 → auto', () => {
    expect(classifyMcpToolPermission('GetUser', TRUSTED)).toBe('auto')
    expect(classifyMcpToolPermission('LIST_FILES', TRUSTED)).toBe('auto')
  })

  // ── 未知语义 → confirm（保守）──────────────────────────
  it('未知工具名 → confirm（保守）', () => {
    expect(classifyMcpToolPermission('do_something', TRUSTED)).toBe('confirm')
  })

  it('空串 → confirm', () => {
    expect(classifyMcpToolPermission('', TRUSTED)).toBe('confirm')
  })

  it('null/undefined → confirm', () => {
    expect(classifyMcpToolPermission(null as unknown as string, TRUSTED)).toBe('confirm')
    expect(classifyMcpToolPermission(undefined as unknown as string, TRUSTED)).toBe('confirm')
  })
})
