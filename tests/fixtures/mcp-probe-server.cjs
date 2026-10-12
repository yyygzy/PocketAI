// 真机验收用的最小 stdio MCP server（B54：要一个"确实起了、且暴露 N 个工具"的 Server）
// 协议按 NDJSON 逐行收发，与 tests/mcp-stdio-win-shim.test.ts 的假 server 同形。
// 用法：设置 → Agent/MCP → 新增 Server，命令填 node，参数填本文件绝对路径。
const readline = require('node:readline')

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const TOOLS = [
  {
    name: 'probe_alpha',
    description: '返回一个只有本 server 知道的暗号',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'probe_beta',
    description: '回声：把传入文本原样返回',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: [] }
  },
  {
    name: 'probe_gamma',
    description: '返回固定数字 4217',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
]

readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.method === 'initialize') {
      out({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe-server', version: '1.0.0' }
        }
      })
    } else if (m.method === 'tools/list') {
      out({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } })
    } else if (m.method === 'tools/call') {
      const name = m.params && m.params.name
      const args = (m.params && m.params.arguments) || {}
      const text =
        name === 'probe_alpha'
          ? '暗号是 紫岚-7731'
          : name === 'probe_beta'
            ? `echo:${args.text ?? ''}`
            : name === 'probe_gamma'
              ? '4217'
              : `unknown tool:${name}`
      out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: false } })
    } else if (m.method === 'shutdown') {
      out({ jsonrpc: '2.0', id: m.id, result: {} })
      setTimeout(() => process.exit(0), 30)
    }
  })
  .on('close', () => process.exit(0))
