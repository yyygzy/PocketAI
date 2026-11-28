// PERF-10：工具注册表帧缓存（一轮 Agent run 内只 buildIndex 一次）+ 失效路径回归
//
// SEC-Batch-14 已做「单次构建 + 两张 Map」，但每次访问仍重建；本次在其上加帧缓存。
// 这里用「getFsTools 调用次数」观测 buildIndex 重建次数（每次 computeIndex 必调一次），
// 钉住两件事：
//  1) 一帧内 N 条工具调用的 classify / getSchema / execute 只重建一次；
//  2) MCP 状态事件与显式 invalidate（IPC 增删改接线）都能让帧内下一次访问立即重建，
//     帧结束也必清——旧索引不会跨轮滞留。
//
// 策略：与 registry-index-parity-29.test.ts 同款桩，避免把 SQLite/electron/凭据链拉进来。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolSchema } from '../src/shared/types'

const mocks = vi.hoisted(() => ({
  builds: 0,
  mcpListCalls: 0,
  statusHandlers: [] as Array<() => void>,
  mcpTools: [] as ToolSchema[],
  runtimeEnv: {} as Record<string, string>
}))

const mcpTool = (name: string): ToolSchema => ({
  id: `mcp:srv-a:${name}`,
  name,
  description: `来自 srv-a 的 ${name}`,
  parameters: { type: 'object', properties: {} },
  source: 'mcp',
  permission: 'auto',
  mcpServerId: 'srv-a'
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: {} }))
vi.mock('../src/main/tools/builtin', () => ({
  ToolDecision: {},
  BUILTIN_TOOLS: [{
    schema: {
      id: 'fs.write',
      name: 'fs_write',
      description: '内置写文件',
      parameters: { type: 'object', properties: {} },
      source: 'builtin',
      permission: 'auto'
    },
    execute: async () => 'BUILTIN_RAN'
  }]
}))
vi.mock('../src/main/tools/fs-tools', () => ({
  getFsTools: () => {
    mocks.builds += 1
    return []
  }
}))
vi.mock('../src/main/tools/patch-tools', () => ({ getPatchTools: () => [] }))
vi.mock('../src/main/tools/run-tests', () => ({ getRunTestsTools: () => [] }))
vi.mock('../src/main/tools/symbol-tools', () => ({ getSymbolTools: () => [] }))
vi.mock('../src/main/tools/mcp-symbol-tools', () => ({ getMcpSymbolTools: () => [] }))
vi.mock('../src/main/tools/shell-tools', () => ({
  getShellTools: () => [],
  getShellPolicyInfo: () => ({ enabled: true, policy: 'ask' })
}))
vi.mock('../src/main/tools/skill-tools', () => ({ getSkillTools: () => [] }))
vi.mock('../src/main/tools/skill-script-tools', () => ({ getSkillScriptTools: () => [] }))
vi.mock('../src/main/tools/artifact-tools', () => ({ getArtifactTools: () => [] }))
vi.mock('../src/main/tools/project-tools', () => ({ getProjectTools: () => [] }))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: {
    listRuntimes: () => {
      mocks.mcpListCalls += 1
      return [{
        status: 'running',
        tools: mocks.mcpTools,
        // 凭据只存在于 runtime 记录里，不应随索引缓存被带出去
        env: mocks.runtimeEnv,
        headers: {}
      }]
    },
    onStatus: (handler: () => void) => {
      mocks.statusHandlers.push(handler)
      return () => {}
    },
    callTool: async () => ({ content: [] })
  }
}))

import { toolRegistry } from '../src/main/tools/registry'

beforeEach(() => {
  mocks.builds = 0
  mocks.mcpListCalls = 0
  mocks.mcpTools = []
  mocks.runtimeEnv = {}
  // 每个用例都从「无帧、无脏快照」起步；endFrame 在 depth=0 时是 no-op
  toolRegistry.endFrame()
  toolRegistry.invalidate()
})

describe('PERF-10 — 一轮 run 内只构建一次索引', () => {
  it('N 条工具调用的 classify/getSchema/execute 共 1 次 buildIndex（2N+2 → 1）', async () => {
    mocks.mcpTools = [mcpTool('read_file')]
    const n = 8
    toolRegistry.beginFrame()
    for (let i = 0; i < n; i++) {
      // 引擎每条工具调用实际访问 4 次工具面（classify / 审批预览 getSchema /
      // executeWithTimeout getSchema / execute），这里按同样密度压测
      toolRegistry.classify('fs_write', '{}', new Set(['*']))
      toolRegistry.getSchema('fs_write')
      toolRegistry.getSchema('read_file')
      await toolRegistry.execute('fs_write', '{}', new Set(['fs.write']))
    }
    toolRegistry.endFrame()

    expect(mocks.builds).toBe(1)
    expect(mocks.mcpListCalls).toBe(1)
  })

  it('帧内多次 listAll 返回同一份只读快照（同一引用）', () => {
    toolRegistry.beginFrame()
    const first = toolRegistry.listAll()
    const second = toolRegistry.listAll()
    expect(second).toBe(first)
    toolRegistry.endFrame()
    expect(mocks.builds).toBe(1)
  })

  it('帧外保持旧语义：每次访问仍重建（策略屏/面板试运行不被长期快照卡住）', () => {
    toolRegistry.listAll()
    toolRegistry.getSchema('fs_write')
    toolRegistry.classify('fs_write', '{}', new Set(['*']))
    expect(mocks.builds).toBe(3)
    expect(mocks.mcpListCalls).toBe(3)
  })

  it('委派嵌套帧不提前释放快照，最外层退出才清', () => {
    toolRegistry.beginFrame()
    toolRegistry.beginFrame() // 子 run
    toolRegistry.listAll()
    toolRegistry.endFrame() // 子 run 结束
    toolRegistry.listAll()
    expect(mocks.builds).toBe(1)
    toolRegistry.endFrame() // 父 run 结束
    toolRegistry.listAll()
    expect(mocks.builds).toBe(2)
  })
})

describe('PERF-10 — 失效路径', () => {
  it('MCP 状态事件（启停/自动重启，不经 IPC）让帧内下一次访问立即重建', () => {
    mocks.mcpTools = [mcpTool('old_tool')]
    toolRegistry.beginFrame()
    expect(toolRegistry.listAll().some((t) => t.name === 'old_tool')).toBe(true)
    expect(mocks.builds).toBe(1)

    // 模拟 manager 在 tools/list 刷新后 emit status
    mocks.mcpTools = [mcpTool('new_tool')]
    expect(mocks.statusHandlers.length).toBeGreaterThan(0)
    mocks.statusHandlers.forEach((h) => h())

    const after = toolRegistry.listAll()
    expect(after.some((t) => t.name === 'new_tool')).toBe(true)
    expect(after.some((t) => t.name === 'old_tool')).toBe(false)
    expect(mocks.builds).toBe(2)
    toolRegistry.endFrame()
  })

  it('显式 invalidate（IPC 增删改接线）让帧内下一次访问立即重建', () => {
    mocks.mcpTools = [mcpTool('before')]
    toolRegistry.beginFrame()
    expect(toolRegistry.listAll().some((t) => t.name === 'before')).toBe(true)

    mocks.mcpTools = [mcpTool('after')]
    toolRegistry.invalidate() // MCP_SERVER_SAVE / DELETE / IMPORT 等调用
    const after = toolRegistry.listAll()
    expect(after.some((t) => t.name === 'after')).toBe(true)
    expect(after.some((t) => t.name === 'before')).toBe(false)
    expect(mocks.builds).toBe(2)
    toolRegistry.endFrame()
  })

  it('帧结束即丢弃：下一帧看到新的工具面，旧索引不滞留', () => {
    mocks.mcpTools = [mcpTool('first_frame')]
    toolRegistry.beginFrame()
    expect(toolRegistry.listAll().some((t) => t.name === 'first_frame')).toBe(true)
    toolRegistry.endFrame()

    mocks.mcpTools = [mcpTool('second_frame')] // 模拟工作目录/策略/连接器在两轮之间变化
    toolRegistry.beginFrame()
    const tools = toolRegistry.listAll()
    expect(tools.some((t) => t.name === 'first_frame')).toBe(false)
    expect(tools.some((t) => t.name === 'second_frame')).toBe(true)
    expect(mocks.builds).toBe(2)
    toolRegistry.endFrame()
  })

  it('缓存产物只含 ToolSchema，不把 MCP env/headers 明文带进索引', () => {
    mocks.runtimeEnv = { API_TOKEN: 'super-secret-token-should-not-be-cached' }
    mocks.mcpTools = [mcpTool('read_file')]
    toolRegistry.beginFrame()
    const cached = JSON.stringify(toolRegistry.listAll())
    expect(cached).not.toContain('super-secret-token-should-not-be-cached')
    expect(cached).not.toContain('API_TOKEN')
    toolRegistry.endFrame()
  })
})
