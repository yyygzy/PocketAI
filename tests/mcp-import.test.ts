import { describe, it, expect } from 'vitest'
import { parseMcpServersJson, inferMcpRuntime } from '../src/shared/mcp-import'

describe('mcp-import', () => {
  describe('inferMcpRuntime', () => {
    it.each([
      ['node', 'node'],
      ['npx', 'node'],
      ['bun', 'node'],
      ['bunx', 'node'],
      ['python', 'python'],
      ['python3', 'python'],
      ['uv', 'python'],
      ['uvx', 'python'],
      ['custom-tool', 'binary'],
      ['/usr/local/bin/node', 'node'],
      ['C:\\Python311\\python.exe', 'python'],
      ['npx.cmd', 'node'],
    ])('infers %s → %s', (cmd, expected) => {
      expect(inferMcpRuntime(cmd)).toBe(expected)
    })
  })

  describe('parseMcpServersJson', () => {
    it('顶层非对象', () => {
      const r = parseMcpServersJson('[]')
      expect(r.error).toContain('必须是 JSON 对象')
      expect(r.items).toEqual([])
    })

    it('mcpServers 字段非对象', () => {
      const r = parseMcpServersJson('{"mcpServers":[]}')
      expect(r.error).toContain('缺少')
    })

    it('空 mcpServers', () => {
      const r = parseMcpServersJson('{"mcpServers":{}}')
      expect(r.error).toContain('为空')
    })

    it('JSON 格式非法', () => {
      const r = parseMcpServersJson('not json')
      expect(r.error).toContain('JSON 解析失败')
    })

    it('解析 stdio 条目', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: {
          fs: { command: 'npx', args: ['-y', '@scope/server-fs', '/tmp'], env: { KEY: 'val' } }
        }
      }))
      expect(r.error).toBeUndefined()
      expect(r.items).toHaveLength(1)
      const item = r.items[0]!
      expect(item.error).toBeUndefined()
      expect(item.draft).toMatchObject({
        name: 'fs',
        transport: 'stdio',
        runtime: 'node',
        command: 'npx',
        args: ['-y', '@scope/server-fs', '/tmp'],
        env: { KEY: 'val' },
        url: null,
        headers: {},
        enabled: true,
        pythonPackages: []
      })
    })

    it('解析 http 条目', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer tok' } }
        }
      }))
      expect(r.error).toBeUndefined()
      const item = r.items[0]!
      expect(item.draft).toMatchObject({
        name: 'remote',
        transport: 'http',
        runtime: 'binary',
        command: null,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer tok' }
      })
    })

    it('sse 按 http 处理并告警', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: { s: { type: 'sse', url: 'https://x.com/sse' } }
      }))
      const item = r.items[0]!
      expect(item.draft?.transport).toBe('http')
      expect(item.warning).toContain('sse')
    })

    it('错误条目不阻断正常条目', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: {
          good: { command: 'node' },
          bad: { command: 123 }
        }
      }))
      expect(r.items).toHaveLength(2)
      expect(r.items[0]!.draft).toBeDefined()
      expect(r.items[1]!.error).toBeDefined()
    })

    it('直接传 mcpServers 对象本身（省略顶层键）', () => {
      const r = parseMcpServersJson(JSON.stringify({
        good: { command: 'python' }
      }))
      expect(r.error).toBeUndefined()
      expect(r.items).toHaveLength(1)
    })

    it('http url 协议非法', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: { bad: { url: 'ftp://x' } }
      }))
      expect(r.items[0]!.error).toContain('http(s)')
    })

    it('args 非数组报错', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: { bad: { command: 'node', args: 'oops' } }
      }))
      expect(r.items[0]!.error).toContain('args')
    })

    it('x-pocketai-python-packages 数组还原到 pythonPackages', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: { py: { command: 'uvx', 'x-pocketai-python-packages': ['mcp-server-fetch==0.1.0'] } }
      }))
      expect(r.items[0]!.draft?.pythonPackages).toEqual(['mcp-server-fetch==0.1.0'])
    })

    it('x-pocketai-python-packages 非数组时忽略并告警', () => {
      const r = parseMcpServersJson(JSON.stringify({
        mcpServers: { py: { command: 'uvx', 'x-pocketai-python-packages': 'oops' } }
      }))
      expect(r.items[0]!.draft?.pythonPackages).toEqual([])
      expect(r.items[0]!.warning).toContain('x-pocketai-python-packages')
    })
  })
})
