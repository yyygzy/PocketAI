import { describe, it, expect } from 'vitest'
import type { McpServerRecord } from '../src/shared/types'
import {
  buildMcpExportPayload,
  REDACTED_PLACEHOLDER,
  PYTHON_PACKAGES_KEY
} from '../src/shared/mcp-export'
import { parseMcpServersJson } from '../src/shared/mcp-import'

function rec(partial: Partial<McpServerRecord> & Pick<McpServerRecord, 'name' | 'transport'>): McpServerRecord {
  return {
    id: `id-${partial.name}`,
    runtime: 'node',
    command: null,
    args: [],
    env: {},
    url: null,
    headers: {},
    enabled: true,
    createdAt: 1700000000000,
    pythonPackages: [],
    ...partial
  }
}

describe('mcp-export', () => {
  it('空列表导出空 mcpServers', () => {
    const r = buildMcpExportPayload([])
    expect(r.mcpServers).toEqual({})
    expect(r.redactedCount).toBe(0)
  })

  it('stdio 条目形状：command/args，空 env 省略', () => {
    const r = buildMcpExportPayload([
      rec({ name: 'fs', transport: 'stdio', runtime: 'node', command: 'npx', args: ['-y', 'fs'] })
    ])
    expect(r.mcpServers.fs).toEqual({ command: 'npx', args: ['-y', 'fs'] })
  })

  it('http 条目形状：type/url，空 headers 省略', () => {
    const r = buildMcpExportPayload([
      rec({ name: 'remote', transport: 'http', url: 'https://example.com/mcp' })
    ])
    expect(r.mcpServers.remote!).toEqual({ type: 'http', url: 'https://example.com/mcp' })
  })

  it('http headers 非空时导出', () => {
    const r = buildMcpExportPayload([
      rec({
        name: 'remote',
        transport: 'http',
        url: 'https://example.com',
        headers: { 'X-Trace': 'abc' }
      })
    ])
    expect(r.mcpServers.remote!.headers).toEqual({ 'X-Trace': 'abc' })
  })

  it('敏感键（env 与 headers）统一脱敏并计数', () => {
    const r = buildMcpExportPayload([
      rec({
        name: 'fs',
        transport: 'stdio',
        command: 'node',
        env: {
          Authorization: 'Bearer secret-token',
          'api-key': 'k1',
          'X-API-KEY': 'k2',
          TOKEN: 't',
          CLIENT_SECRET: 's',
          PASSWORD: 'p',
          passwd: 'pw',
          CREDENTIAL: 'c',
          bearer: 'b',
          PATH: '/usr/bin',
          NODE_ENV: 'production'
        }
      }),
      rec({
        name: 'remote',
        transport: 'http',
        url: 'https://example.com',
        headers: { Authorization: 'Bearer x', 'X-Trace': 'ok' }
      })
    ])
    expect(r.redactedCount).toBe(10)
    const env = r.mcpServers.fs!.env!
    expect(env.Authorization).toBe(REDACTED_PLACEHOLDER)
    expect(env['api-key']).toBe(REDACTED_PLACEHOLDER)
    expect(env['X-API-KEY']).toBe(REDACTED_PLACEHOLDER)
    expect(env.TOKEN).toBe(REDACTED_PLACEHOLDER)
    expect(env.CLIENT_SECRET).toBe(REDACTED_PLACEHOLDER)
    expect(env.PASSWORD).toBe(REDACTED_PLACEHOLDER)
    // 非敏感键原样保留
    expect(env.PATH).toBe('/usr/bin')
    expect(env.NODE_ENV).toBe('production')
    expect(r.mcpServers.remote!.headers!.Authorization).toBe(REDACTED_PLACEHOLDER)
    expect(r.mcpServers.remote!.headers!['X-Trace']).toBe('ok')
  })

  it('redactSecrets:false 时原样导出', () => {
    const r = buildMcpExportPayload(
      [rec({ name: 'fs', transport: 'stdio', command: 'x', env: { API_KEY: 'real' } })],
      { redactSecrets: false }
    )
    expect(r.redactedCount).toBe(0)
    expect(r.mcpServers.fs!.env!.API_KEY).toBe('real')
  })

  it('不导出 id/enabled/createdAt/runtime', () => {
    const r = buildMcpExportPayload([
      rec({ name: 'fs', transport: 'stdio', command: 'node', enabled: false })
    ])
    const entry = r.mcpServers.fs as Record<string, unknown>
    expect(entry.id).toBeUndefined()
    expect(entry.enabled).toBeUndefined()
    expect(entry.createdAt).toBeUndefined()
    expect(entry.runtime).toBeUndefined()
    // 禁用服务仍导出
    expect(entry.command).toBe('node')
  })

  it('python 运行时的 pip 包写入扩展键；非 python 不写', () => {
    const r = buildMcpExportPayload([
      rec({
        name: 'py',
        transport: 'stdio',
        runtime: 'python',
        command: 'uvx',
        pythonPackages: ['mcp-server-fetch==0.1.0', 'httpx']
      }),
      rec({ name: 'node-srv', transport: 'stdio', runtime: 'node', command: 'npx' })
    ])
    expect(r.mcpServers.py![PYTHON_PACKAGES_KEY]).toEqual(['mcp-server-fetch==0.1.0', 'httpx'])
    expect((r.mcpServers['node-srv'] as Record<string, unknown>)[PYTHON_PACKAGES_KEY]).toBeUndefined()
  })

  it('python 包列表为空时省略扩展键', () => {
    const r = buildMcpExportPayload([
      rec({ name: 'py', transport: 'stdio', runtime: 'python', command: 'python' })
    ])
    expect((r.mcpServers.py as Record<string, unknown>)[PYTHON_PACKAGES_KEY]).toBeUndefined()
  })

  it('与 parseMcpServesJson round-trip：stdio/http/python 扩展键均还原', () => {
    const records: McpServerRecord[] = [
      rec({
        name: 'fs',
        transport: 'stdio',
        runtime: 'node',
        command: 'npx',
        args: ['-y', 'srv'],
        env: { PATH: '/bin' }
      }),
      rec({
        name: 'py',
        transport: 'stdio',
        runtime: 'python',
        command: 'uvx',
        pythonPackages: ['mcp-server-fetch']
      }),
      rec({
        name: 'remote',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Trace': 't' }
      })
    ]
    const payload = buildMcpExportPayload(records, { redactSecrets: false })
    const parsed = parseMcpServersJson(JSON.stringify(payload.mcpServers))
    expect(parsed.error).toBeUndefined()
    const byKey = Object.fromEntries(parsed.items.map((i) => [i.key, i.draft!]))

    expect(byKey.fs).toMatchObject({
      transport: 'stdio',
      runtime: 'node',
      command: 'npx',
      args: ['-y', 'srv'],
      env: { PATH: '/bin' }
    })
    expect(byKey.py).toMatchObject({
      transport: 'stdio',
      runtime: 'python',
      command: 'uvx',
      pythonPackages: ['mcp-server-fetch']
    })
    expect(byKey.remote).toMatchObject({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-Trace': 't' }
    })
  })
})
