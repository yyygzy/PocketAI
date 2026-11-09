// P0-3b（2026-11-06）：新补进 CONFIRM 的写盘命令，在 "auto-safe"（仅危险确认）档下
// 会不会被重新降级成自动执行？
//
// 结论钉在这里：`classifyShellArgs` 的 auto-safe 分支直接返回 `classifyCommand` 的结果
// （shell-tools.ts），没有"把 confirm 再放行"的白名单。所以新规则在该档下**仍然 confirm**；
// 反例 `ls -la` 仍是 allow，证明这一档不是"全部弹窗"。
//
// 依赖桩与 tool-policy-same-source-417 同源：registry 的 import 链会拉 portable/db/MCP/skill。
import { describe, expect, it, vi } from 'vitest'

const WS = 'C:\\agent-workspace'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) =>
      key === 'agent.workspace_dir'
        ? WS
        : key === 'agent.shell_enabled'
          ? '1'
          : key === 'agent.shell_policy'
            ? 'auto-safe'
            : null,
    set: () => {},
    delete: () => {}
  }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => [], callTool: async () => ({ isError: false }) }
}))

import { toolRegistry } from '../src/main/tools/registry'

/** 走真实入口：registry 取 schema → builtin.classify(args) → 与基线取更严 */
const classifyShell = (command: string) =>
  toolRegistry.classify('shell_exec', JSON.stringify({ command }), new Set(['*']))

describe('auto-safe 档：新规则仍为 confirm（没有被降级成自动执行）', () => {
  it('tee / sed -i / 解包 / 脚本文件：全部 confirm，且原因码是新加的那条', () => {
    for (const command of [
      'tee out.txt',
      "sed -i 's/a/b/' f.txt",
      'tar -xzf a.tgz',
      'unzip a.zip',
      'python build.py',
      'node scripts/gen.js'
    ]) {
      expect(classifyShell(command), command).toEqual({
        decision: 'confirm',
        reason: 'DANGEROUS_WRITE',
        risk: 'danger',
        forceConfirm: true
      })
    }
  })

  it('git 覆盖工作区：confirm；只动索引的 restore 仍是 allow', () => {
    expect(classifyShell('git restore .')).toEqual({
      decision: 'confirm',
      reason: 'DANGEROUS_WRITE',
      risk: 'danger',
      forceConfirm: true
    })
    expect(classifyShell('git checkout -- .')).toEqual({
      decision: 'confirm',
      reason: 'DANGEROUS_WRITE',
      risk: 'danger',
      forceConfirm: true
    })
    expect(classifyShell('git restore --staged .')).toEqual({ decision: 'allow' })
  })

  it('反例：普通只读命令在该档下仍是 allow（不是把整档变成逐条确认）', () => {
    expect(classifyShell('ls -la')).toEqual({ decision: 'allow' })
    expect(classifyShell('git status')).toEqual({ decision: 'allow' })
  })
})
