// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ToolPolicyDialog } from '../src/renderer/src/modules/agent/components/ToolPolicyDialog'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import type { ToolPolicySnapshot } from '../src/shared/types'

const registrySnapshot: ToolPolicySnapshot = {
  tools: [
    {
      id: 'fs.read',
      name: 'fs_read',
      source: 'builtin',
      permission: 'auto',
      state: 'available',
      dynamic: false,
      reasons: []
    },
    {
      id: 'fs.write',
      name: 'fs_write',
      source: 'builtin',
      permission: 'confirm',
      state: 'available',
      dynamic: false,
      reasons: ['WRITES_WORKSPACE_FILE']
    },
    {
      id: 'shell.exec',
      name: 'shell_exec',
      source: 'builtin',
      permission: 'auto',
      state: 'disabled',
      dynamic: true,
      reasons: []
    },
    {
      id: 'mcp:demo',
      name: 'mcp_demo',
      source: 'mcp',
      permission: 'auto',
      state: 'needs-explicit',
      dynamic: false,
      reasons: []
    }
  ],
  shell: {
    enabled: false,
    policy: 'confirm',
    confirmReasons: ['DANGEROUS_DELETE', 'ONLY_FROM_SNAPSHOT'],
    denyReasons: ['BLOCKED_FORMAT']
  },
  mcpStoppedServers: 0
}

/** 空数组语义：自建助手 `[]` ⇒ 一个都不给；屏上以 not-granted 与横幅两处说清楚 */
const emptyAssistantSnapshot: ToolPolicySnapshot = {
  ...registrySnapshot,
  assistant: {
    id: 'a-empty',
    name: '空白助手',
    isBuiltin: false,
    permissions: [],
    emptyPermissions: true,
    loadSkillAvailable: false,
    tools: registrySnapshot.tools.map((t) => ({ ...t, state: 'not-granted', granted: false }))
  }
}

/** 内置助手 `['*']` ⇒ 全部内置；MCP 仍是“需逐条授权” */
const starAssistantSnapshot: ToolPolicySnapshot = {
  ...registrySnapshot,
  mcpStoppedServers: 1,
  assistant: {
    id: 'a-builtin',
    name: '默认助手',
    isBuiltin: true,
    permissions: ['*'],
    emptyPermissions: false,
    loadSkillAvailable: true,
    tools: registrySnapshot.tools.map((t) => ({
      ...t,
      state: t.source === 'mcp' ? 'needs-explicit' : t.state === 'disabled' ? 'disabled' : 'available',
      granted: t.source !== 'mcp'
    }))
  }
}

describe('工具策略屏（P0-3a／P0-3c）', () => {
  it('默认落在「当前助手」；无助手上下文给明确空态而不是退化回全量', async () => {
    stubPocketai({ getToolPolicy: () => registrySnapshot })
    mountWithProviders(<ToolPolicyDialog onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('tp-no-assistant')).toBeTruthy())
    expect(screen.getByText('没有当前助手上下文')).toBeTruthy()
    expect(screen.getByText('未选择助手或找不到该助手，因此无法显示实际生效工具面；可切到「注册表全量」查看所有已注册工具。')).toBeTruthy()
    expect(screen.queryByText('fs_read')).toBeNull()
  })

  it('切到「注册表全量」后逐档渲染快照：内置/MCP、停用/需授权、确认原因都来自 IPC 返回', async () => {
    stubPocketai({ getToolPolicy: () => registrySnapshot })
    mountWithProviders(<ToolPolicyDialog onClose={() => {}} />)

    await waitFor(() => expect(screen.getByTestId('tp-no-assistant')).toBeTruthy())
    screen.getByText('注册表全量').click()
    await waitFor(() => expect(screen.getByText('fs_read')).toBeTruthy())
    expect(screen.getByText('fs_write')).toBeTruthy()
    expect(screen.getAllByText('自动执行').length).toBeGreaterThan(0)
    expect(screen.getAllByText('需要批准').length).toBeGreaterThan(0)
    expect(screen.getByText('写入工作区文件')).toBeTruthy()
    // 停用与“需逐条授权”不是同一个“关闭”
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0)
    expect(screen.getByText('需逐条授权')).toBeTruthy()
    expect(screen.getByText('终端工具当前未启用，模型看不到它；下方规则仍按注册表展示')).toBeTruthy()
    // 终端规则同样按快照里的码渲染；ONLY_FROM_SNAPSHOT 在屏里没有本地名单，只能来自返回对象（表外码原样显示）
    expect(screen.getByText('删除文件（含 git clean -f）')).toBeTruthy()
    expect(screen.getByText('ONLY_FROM_SNAPSHOT')).toBeTruthy()
    expect(screen.getByText('格式化磁盘')).toBeTruthy()
    // 注册表视角才标 `*` 的 MCP 口径
    expect(screen.getByText('* 只覆盖内置工具，MCP 工具必须逐条勾选；勾选后仍按各自判定执行')).toBeTruthy()
    expect(screen.getByText('这不是权限编辑器：要改开关请回到工具配置')).toBeTruthy()
  })

  it('用户自建助手空数组：横幅说“一个都不给”，每行标未授权且与内置助手长得不一样', async () => {
    stubPocketai({ getToolPolicy: () => emptyAssistantSnapshot })
    mountWithProviders(<ToolPolicyDialog assistantId="a-empty" onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('当前助手：空白助手')).toBeTruthy())
    expect(screen.getByText('自建助手')).toBeTruthy()
    expect(screen.getByText(/这个自建助手没有勾选任何工具/)).toBeTruthy()
    expect(screen.getByText('该助手的生效面里没有 load_skill：按需技能无法按需取回，会退化为全文注入，并因此占用常驻技能总预算。')).toBeTruthy()
    expect(screen.getAllByText('未授权').length).toBe(registrySnapshot.tools.length)
    expect(screen.queryByText('该助手声明了 \'*\'：全部内置工具可用；但 MCP 工具仍需逐条勾选。')).toBeNull()
  })

  it('内置助手 `*`：内置可用、MCP 仍需逐条，另有未启动 Server 的说明', async () => {
    stubPocketai({ getToolPolicy: () => starAssistantSnapshot })
    mountWithProviders(<ToolPolicyDialog assistantId="a-builtin" onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('当前助手：默认助手')).toBeTruthy())
    expect(screen.getByText('内置助手')).toBeTruthy()
    expect(screen.getByText('该助手声明了 \'*\'：全部内置工具可用；但 MCP 工具仍需逐条勾选。')).toBeTruthy()
    expect(screen.queryByText(/这个自建助手没有勾选任何工具/)).toBeNull()
    expect(screen.getByText('另有 1 个 MCP Server 未启动，它们的工具不在本列。')).toBeTruthy()
    expect(screen.getByText('需逐条授权')).toBeTruthy()
  })

  it('读取失败给原因与重试，不把空表当“没有工具”', async () => {
    const getToolPolicy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'db busy' })
      .mockResolvedValueOnce(registrySnapshot)
    stubPocketai({ getToolPolicy })
    mountWithProviders(<ToolPolicyDialog onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('工具策略读取失败：db busy')).toBeTruthy())
    screen.getByText('重试').click()
    await waitFor(() => expect(screen.getByTestId('tp-no-assistant')).toBeTruthy())
  })
})
