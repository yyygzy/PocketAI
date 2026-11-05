// @vitest-environment node
// registry 的 import 链会拉到 portable（顶层读 app.isPackaged）、db（顶层建连接）、MCP/skill 仓库；
// 这里只需要判定函数本身，不碰库，于是按既有 main 测试的写法把这些外部依赖桩掉。
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { list: () => [], get: () => undefined }
}))

import { toolRegistry, isToolAllowedBy } from '../src/main/tools/registry'
import { classifyCommand, getShellPolicyInfo } from '../src/main/tools/shell-tools'
import type { ToolSchema } from '../src/shared/types'

const WS = 'C:\\tmp\\pocketai-policy-test'

/** 这些判定值只能由 registry 那一处给出；屏只是把返回对象摊开 */
describe('工具策略快照与 registry 同源（P0-3a）', () => {
  it('终端段的开关/策略/原因码整份等于 getShellPolicyInfo() 的返回', () => {
    const snap = toolRegistry.policySnapshot()
    expect(snap.shell).toEqual(getShellPolicyInfo())
  })

  it('真实命令的分类原因能在这份快照的池子里找到（不是另写一份名单）', () => {
    const snap = toolRegistry.policySnapshot()
    const del = classifyCommand('rm -rf build', WS)
    expect(del.decision).toBe('confirm')
    expect(del.reason).toBeTruthy()
    expect(snap.shell.confirmReasons).toContain(del.reason)

    const wipe = classifyCommand('format C:', WS)
    expect(wipe.decision).toBe('deny')
    expect(wipe.reason).toBeTruthy()
    expect(snap.shell.denyReasons).toContain(wipe.reason)
  })

  it('内置入口的权限/状态直接来自 schema.permission', () => {
    const snap = toolRegistry.policySnapshot()
    for (const entry of snap.tools.filter((t) => t.source === 'builtin')) {
      // 终端即使被停用也单独补进快照，它的 schema 不在 listBuiltin 里
      if (entry.id === 'shell.exec') continue
      const schema = toolRegistry.listBuiltin().find((s) => s.id === entry.id)
      expect(schema).toBeTruthy()
      expect(entry.permission).toBe(schema!.permission ?? 'auto')
      expect(entry.state).toBe(schema!.permission === 'deny' ? 'denied' : 'available')
    }
    // 停用的终端不能被演成“已拒绝”或“需授权”
    const shell = snap.tools.find((t) => t.id === 'shell.exec')!
    expect(shell.state).toBe(snap.shell.enabled ? 'available' : 'disabled')
  })

  it('MCP 的 `*` 不覆盖口径与 isToolAllowedBy 一致', () => {
    const mcp: ToolSchema = {
      id: 'mcp:demo',
      name: 'mcp_demo',
      description: '',
      parameters: { type: 'object' },
      source: 'mcp',
      permission: 'auto'
    }
    expect(isToolAllowedBy(new Set(['*']), mcp)).toBe(false)
    expect(isToolAllowedBy(new Set(['mcp:demo']), mcp)).toBe(true)
    // 快照里 MCP 一律是“需逐条授权”，而不是“可用”
    for (const entry of toolRegistry.policySnapshot().tools.filter((t) => t.source === 'mcp')) {
      expect(entry.state).toBe('needs-explicit')
    }
  })
})
