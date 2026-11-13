// @vitest-environment node
// P0-5 dry-run 回放：工具禁用（测试先行）
//
// 判据来自 docs/product-plan-2026-11.md 第 3 节「dry-run（若做）」：
// 回放全程不执行工具。这里钉的是**执行收口**那一层：回放作用域内任何一条工具调用
// 都必须被硬拒，底层 `execute` 一次都不能被调用；作用域外不受影响（它不是全局开关）。
import { describe, it, expect, vi } from 'vitest'

const probe = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../src/main/tools/builtin', () => ({
  BUILTIN_TOOLS: [
    {
      schema: {
        id: 'test.echo',
        name: 'test_echo',
        description: '测试用工具：被调用就记一笔',
        parameters: { type: 'object', properties: {} },
        source: 'builtin',
        permission: 'auto'
      },
      execute: async () => {
        probe.calls.push('test_echo')
        return 'ok'
      }
    }
  ],
  ToolDecision: {}
}))
vi.mock('../src/main/tools/fs-tools', () => ({ getFsTools: () => [] }))
vi.mock('../src/main/tools/shell-tools', () => ({
  getShellTools: () => [],
  getShellPolicyInfo: () => ({ enabled: false })
}))
vi.mock('../src/main/tools/skill-tools', () => ({ getSkillTools: () => [] }))
vi.mock('../src/main/tools/artifact-tools', () => ({ getArtifactTools: () => [] }))
vi.mock('../src/main/tools/project-tools', () => ({ getProjectTools: () => [] }))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => [], listMcpTools: () => [], callTool: async () => ({ isError: false }) }
}))

import { toolRegistry } from '../src/main/tools/registry'
import { DRY_RUN_TOOL_BLOCKED, runWithToolsDisabled } from '../src/main/agent/dry-run-scope'

describe('dry-run 回放：工具全程被禁用', () => {
  it('回放作用域内任何工具执行都被硬拒，底层 execute 一次都没被调用', async () => {
    const allowed = new Set(['*'])

    await expect(
      runWithToolsDisabled(async (state) => {
        expect(state.blockedAttempts).toBe(0)
        await toolRegistry.execute('test_echo', '{}', allowed)
      })
    ).rejects.toThrow(DRY_RUN_TOOL_BLOCKED)

    expect(probe.calls, '被禁用的调用不许落到工具实现里').toEqual([])
  })

  it('作用域外执行不受影响：guard 是作用域而不是全局开关', async () => {
    const result = await toolRegistry.execute('test_echo', '{}', new Set(['*']))
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('ok')
    expect(probe.calls).toEqual(['test_echo'])
  })
})
