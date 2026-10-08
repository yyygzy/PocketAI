// MCP 启动命令呈现（导入预览与启动前确认共用）
import { describe, it, expect } from 'vitest'
import { formatMcpLaunch, mcpSecretKeyHint } from '../src/renderer/src/modules/agent/mcp/mcp-launch'

describe('formatMcpLaunch', () => {
  it('stdio：命令与参数拼成一行', () => {
    expect(formatMcpLaunch({ transport: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'] })).toBe(
      'npx -y fs-mcp'
    )
  })

  it('含空白的参数加引号呈现，保留参数边界', () => {
    expect(formatMcpLaunch({ transport: 'stdio', command: 'python', args: ['-c', 'rm -rf /'] })).toBe(
      'python -c "rm -rf /"'
    )
  })

  it('空参数项被跳过', () => {
    expect(formatMcpLaunch({ transport: 'stdio', command: ' node ', args: ['', 'a.js', ''] })).toBe('node a.js')
  })

  it('stdio：只有 command 无 args 也正常', () => {
    expect(formatMcpLaunch({ transport: 'stdio', command: 'uvx', args: [] })).toBe('uvx')
  })

  it('http：显示 URL 而非命令', () => {
    expect(formatMcpLaunch({ transport: 'http', url: 'https://example.com/mcp' })).toBe(
      'https://example.com/mcp'
    )
    expect(formatMcpLaunch({ transport: 'http', url: null })).toBe('')
  })

  it('缺记录/缺字段返回空串（不显示 undefined）', () => {
    expect(formatMcpLaunch(null)).toBe('')
    expect(formatMcpLaunch(undefined)).toBe('')
    expect(formatMcpLaunch({})).toBe('')
  })
})

describe('mcpSecretKeyHint', () => {
  it('列出 env 与 headers 键名，值不外泄', () => {
    const hint = mcpSecretKeyHint({ env: { API_KEY: 'sk-secret' }, headers: { Authorization: 'Bearer x' } })
    expect(hint).toContain('env:API_KEY')
    expect(hint).toContain('header:Authorization')
    expect(hint).not.toContain('sk-secret')
    expect(hint).not.toContain('Bearer')
  })

  it('无凭据返回空串（调用方据此省略整行提示）', () => {
    expect(mcpSecretKeyHint({ env: {}, headers: {} })).toBe('')
    expect(mcpSecretKeyHint(null)).toBe('')
  })
})
