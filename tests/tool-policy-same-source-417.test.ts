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
// MCP：一个 running（含一条 auto、一条 deny），一个 stopped——后者只能计入 mcpStoppedServers
const mcpRuntime = vi.hoisted(() => {
  const runningTools = [
    {
      id: 'mcp:demo',
      name: 'mcp_demo',
      description: '',
      parameters: { type: 'object' },
      source: 'mcp',
      permission: 'auto'
    },
    {
      id: 'mcp:denied',
      name: 'mcp_denied',
      description: '',
      parameters: { type: 'object' },
      source: 'mcp',
      permission: 'deny'
    }
  ]
  return {
    runningTools,
    runtimes: [
      { status: 'running', tools: runningTools },
      { status: 'stopped', tools: [] }
    ]
  }
})
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => mcpRuntime.runtimes, callTool: async () => ({ isError: false }) }
}))

import { toolRegistry, isToolAllowedBy } from '../src/main/tools/registry'
import { resolveAgentToolPermissions } from '../src/main/agent/tool-permissions'
import { classifyCommand, getShellPolicyInfo } from '../src/main/tools/shell-tools'
import type { ToolSchema, ToolPolicyAssistantContext } from '../src/shared/types'

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
    // 快照里未 deny 的 MCP 一律是“需逐条授权”，而不是“可用”；内在 deny 另算一档
    for (const entry of toolRegistry.policySnapshot().tools.filter((t) => t.source === 'mcp')) {
      expect(entry.state).toBe(entry.permission === 'deny' ? 'denied' : 'needs-explicit')
    }
    // 未启动的 Server 只进计数，不进工具列
    const snap = toolRegistry.policySnapshot()
    expect(snap.mcpStoppedServers).toBe(1)
    expect(snap.tools.filter((t) => t.source === 'mcp').map((t) => t.id).sort()).toEqual([
      'mcp:demo',
      'mcp:denied'
    ])
  })

  it('生效面的 granted 与 isToolAllowedBy 同一判定（按函数身份钉，不数条数）', () => {
    const ctx = assistantContext(['time.now', 'calculator', 'mcp:demo'], false)
    const snap = toolRegistry.policySnapshot(ctx)!
    const allowed = new Set(ctx.permissions)
    const all = toolRegistry.listAll()
    // 生效面与注册表全量覆盖同一批工具 id（只是判据不同，不是两份名单）
    expect(new Set(snap.assistant!.tools.map((t) => t.id))).toEqual(new Set(snap.tools.map((t) => t.id)))
    for (const entry of snap.assistant!.tools) {
      // 终端工具只在「有工作目录且开关开启」时才注册；停用时快照仍补一行，故这里按 id/source 补齐 schema
      const schema =
        all.find((s) => s.id === entry.id) ??
        (entry.id === 'shell.exec'
          ? ({ id: 'shell.exec', name: 'shell_exec', source: 'builtin' } as ToolSchema)
          : undefined)
      expect(schema, entry.id).toBeTruthy()
      expect(entry.granted).toBe(isToolAllowedBy(allowed, schema))
      // state 只由「内在 deny / 策略停用 / granted」三者推导，渲染层不参与
      if (entry.id === 'shell.exec') {
        expect(entry.state).toBe(snap.shell.enabled ? (entry.granted ? 'available' : 'not-granted') : 'disabled')
      } else if (entry.source === 'mcp') {
        expect(entry.state).toBe(
          schema.permission === 'deny' ? 'denied' : entry.granted ? 'available' : 'needs-explicit'
        )
      } else {
        expect(entry.state).toBe(
          schema.permission === 'deny' ? 'denied' : entry.granted ? 'available' : 'not-granted'
        )
      }
    }
    const loadSkill = all.find((s) => s.id === 'skill.load')!
    expect(snap.assistant!.loadSkillAvailable).toBe(isToolAllowedBy(allowed, loadSkill))
  })

  it('两种空数组语义：无助手/内置助手 → [\'*\']，用户自建助手 → []', () => {
    expect(resolveAgentToolPermissions([], { hasAssistant: false, isBuiltin: false })).toEqual(['*'])
    expect(resolveAgentToolPermissions(null, { hasAssistant: false, isBuiltin: false })).toEqual(['*'])
    expect(resolveAgentToolPermissions([], { hasAssistant: true, isBuiltin: true })).toEqual(['*'])
    // 自建助手空数组＝一个都不给，**不是**「全给」
    expect(resolveAgentToolPermissions([], { hasAssistant: true, isBuiltin: false })).toEqual([])
    expect(resolveAgentToolPermissions(['time.now'], { hasAssistant: true, isBuiltin: false })).toEqual(['time.now'])
  })

  it('两种空数组落到屏上是两张不同的脸：`*` 全内置可用、MCP 仍逐条；`[]` 一个都不给', () => {
    const star = toolRegistry.policySnapshot(assistantContext(['*'], true))!
    expect(star.assistant!.emptyPermissions).toBe(false)
    expect(star.assistant!.loadSkillAvailable).toBe(true)
    for (const entry of star.assistant!.tools.filter((t) => t.source === 'builtin' && t.id !== 'shell.exec')) {
      expect(entry.state).toBe(entry.permission === 'deny' ? 'denied' : 'available')
    }
    // `*` 不覆盖 MCP
    for (const entry of star.assistant!.tools.filter((t) => t.source === 'mcp' && t.permission !== 'deny')) {
      expect(entry.granted).toBe(false)
      expect(entry.state).toBe('needs-explicit')
    }

    const empty = toolRegistry.policySnapshot(assistantContext([], false, true))!
    expect(empty.assistant!.emptyPermissions).toBe(true)
    expect(empty.assistant!.loadSkillAvailable).toBe(false)
    for (const entry of empty.assistant!.tools.filter((t) => t.source === 'builtin' && t.id !== 'shell.exec')) {
      // 空数组下内置一个都不给；只有策略停用（终端关着）不算“未授权”
      expect(entry.state).toBe(entry.permission === 'deny' ? 'denied' : 'not-granted')
    }
  })

  it('deny 与未授权分开：`mcp_denied` 是 denied，未勾选的 `mcp_demo` 是 needs-explicit', () => {
    const snap = toolRegistry.policySnapshot(assistantContext(['*'], true))!
    const denied = snap.assistant!.tools.find((t) => t.id === 'mcp:denied')!
    const notGranted = snap.assistant!.tools.find((t) => t.id === 'mcp:demo')!
    expect(denied.state).toBe('denied')
    expect(notGranted.state).toBe('needs-explicit')
    // 两者都“没被授权”，但原因不同：一个内在 deny，一个只是没勾选
    expect(denied.granted).toBe(false)
    expect(notGranted.granted).toBe(false)

    const ctx = assistantContext(['time.now'], false)
    const custom = toolRegistry.policySnapshot(ctx)!
    const calc = custom.assistant!.tools.find((t) => t.id === 'calculator')!
    expect(calc.state).toBe('not-granted')
  })
})

function assistantContext(
  permissions: string[],
  isBuiltin: boolean,
  emptyPermissions = false
): ToolPolicyAssistantContext {
  return {
    id: 'a1',
    name: 'A',
    isBuiltin,
    permissions,
    emptyPermissions
  }
}
