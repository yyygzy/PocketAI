// @vitest-environment jsdom
// B38 的接线证明：运行时日志的颜色取自「该 server 当前状态」，不是取自 stream
//
// 纯函数用例只证了 logLineTone 本身；这里证的是面板真的把状态传进去了——
// 传错（比如永远拿不到 error 态）就会退化成「真错误也不标红」，那是另一种谎话。
import { describe, it, expect } from 'vitest'
import { act } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { McpPanel } from '../src/renderer/src/modules/agent/mcp/McpPanel'
import type {
  McpServerLogEvent,
  McpServerRuntime,
  McpServerStatus
} from '../src/shared/types'

const SERVER_ID = 's1'

let pushLog: ((e: McpServerLogEvent) => void) | null = null

function runtimeWith(status: McpServerStatus): McpServerRuntime {
  return {
    id: SERVER_ID,
    name: 'memory',
    transport: 'stdio',
    runtime: 'node',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    url: null,
    headers: {},
    enabled: true,
    createdAt: 1,
    trustReadOnly: false,
    pythonPackages: [],
    status,
    tools: [],
    lastError: status === 'error' ? 'spawn npx ENOENT' : null,
    pid: 1234
  }
}

async function mountWith(status: McpServerStatus): Promise<RenderResult> {
  pushLog = null
  stubPocketai({
    listMcpServers: () => [],
    getMcpRuntimes: () => [runtimeWith(status)],
    listMcpCallLogs: () => ({ ok: true, logs: [] }),
    onMcpStatus: () => () => {},
    onMcpLog: (handler: (e: McpServerLogEvent) => void) => {
      pushLog = handler
      return () => {}
    },
    onPythonEnvEvent: () => () => {},
    getPythonPipSource: () => ({ ok: true, source: 'official' })
  })
  const r = mountWithProviders(<McpPanel />)
  // 等 getMcpRuntimes 的 promise 落定（runtimes 为空就取不到状态）
  await act(async () => {})
  return r
}

function logDiv(r: RenderResult, needle: string): HTMLElement {
  // 取最深的那个匹配（父容器也"包含"这段文字，文档序里最深的在最后）
  const hits = Array.from(r.container.querySelectorAll('div')).filter((d) =>
    d.textContent?.includes(needle)
  )
  const el = hits[hits.length - 1]
  if (!el) throw new Error(`没找到含「${needle}」的日志行`)
  return el as HTMLElement
}

function emit(stream: 'stdout' | 'stderr', line: string): void {
  act(() => {
    pushLog?.({ serverId: SERVER_ID, stream, line, timestamp: Date.now() })
  })
}

describe('MCP 运行时日志着色（B38 反向对照）', () => {
  it('server 处于 error 态：它的 stderr 行标 danger（真错误仍然是红的）', async () => {
    const r = await mountWith('error')
    emit('stderr', 'npm error code E404')
    expect(logDiv(r, 'npm error code E404').className).toContain('color-danger')
  })

  it('server 正常 running：同样走 stderr 的启动横幅只是 warning', async () => {
    const r = await mountWith('running')
    emit('stderr', 'Knowledge Graph MCP Server running on stdio')
    const cls = logDiv(r, 'running on stdio').className
    expect(cls).toContain('color-warning')
    expect(cls).not.toContain('color-danger')
  })

  it('stdout 一律不涂色（即使 server 已 error）', async () => {
    const r = await mountWith('error')
    emit('stdout', 'plain output line')
    expect(logDiv(r, 'plain output line').className).toBe('')
  })
})
