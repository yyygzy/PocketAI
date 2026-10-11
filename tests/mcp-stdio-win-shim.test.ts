// Windows 批处理垫片的真实起活路用例：**不 mock child_process**
//
// 为什么必须有这条：mcp-manager/json-rpc 的其余用例都把 spawn 桩掉了，于是
// 「command: npx 在 Windows 上根本起不来」（spawn npx ENOENT）在 CI 里永远绿。
// 这里用一个真的 .cmd 垫片 + 真的 node 子进程，把起进程、参数传递、关闭不留孤儿三件事钉住。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StdioJsonRpcClient } from '../src/main/mcp/json-rpc'

/** 假 MCP server：NDJSON 回 initialize/tools/list/tools/call/shutdown */
const FAKE_JS = `
const readline = require('node:readline')
const hang = process.argv.includes('--hang')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    out({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'fake-cmd-server', version: '1.0.0' },
      childPid: process.pid,
      argv: process.argv.slice(2)
    } })
  } else if (m.method === 'tools/list') {
    out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] } })
  } else if (m.method === 'tools/call') {
    out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'got ' + ((m.params && m.params.arguments && m.params.arguments.text) || '') }], isError: false } })
  } else if (m.method === 'shutdown') {
    out({ jsonrpc: '2.0', id: m.id, result: {} })
    if (!hang) setTimeout(() => process.exit(0), 30)
  }
})
`

const dir = path.join(os.tmpdir(), 'pocketai-winshim-test')
const cmdPath = path.join(dir, 'fake-server.cmd')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return cond()
}

function client(args: string[]): StdioJsonRpcClient {
  return new StdioJsonRpcClient({ command: cmdPath, args, requestTimeout: 15_000 })
}

const isWin = process.platform === 'win32'

describe.skipIf(!isWin)('win32 stdio 垫片（真实 spawn，不 mock child_process）', () => {
  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'fake-server.js'), FAKE_JS, 'utf8')
    // 垫片本身：cmd 里再起 node，%* 把参数原样转给子进程
    fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0fake-server.js" %*\r\n', 'utf8')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('.cmd 命令能起、握手能通、参数精确到达子进程', async () => {
    const c = client(['--tag', 'x y'])
    await c.spawn()
    const init = (await c.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    })) as { serverInfo: { name: string }; argv: string[] }
    expect(init.serverInfo.name).toBe('fake-cmd-server')
    // 带空格的参数没有被 cmd 拆成两个（这正是自行加引号要保住的性质）
    expect(init.argv).toEqual(['--tag', 'x y'])

    const listed = (await c.request('tools/list', {})) as { tools: Array<{ name: string }> }
    expect(listed.tools.map((t) => t.name)).toEqual(['echo'])
    const called = (await c.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })) as {
      content: Array<{ text: string }>
    }
    expect(called.content[0]!.text).toBe('got hi')
    await c.shutdown()
  })

  it('优雅退出：server 自己结束时进程消失，不需要强杀', async () => {
    const c = client([])
    await c.spawn()
    const init = (await c.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    })) as { childPid: number }
    await c.shutdown()
    expect(await until(() => !alive(init.childPid))).toBe(true)
  })

  it('赖着不走的 server：关闭必须连进程树杀干净（cmd.exe 是壳，proc.kill 只杀壳）', async () => {
    const c = client(['--hang'])
    await c.spawn()
    const init = (await c.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    })) as { childPid: number }
    expect(alive(init.childPid)).toBe(true)
    await c.shutdown()
    expect(await until(() => !alive(init.childPid), 8000)).toBe(true)
  })
})
