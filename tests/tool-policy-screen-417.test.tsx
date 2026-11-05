// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { ToolPolicyDialog } from '../src/renderer/src/modules/agent/components/ToolPolicyDialog'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import type { ToolPolicySnapshot } from '../src/shared/types'

const snapshot: ToolPolicySnapshot = {
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
  }
}

describe('工具策略屏（P0-3a）', () => {
  it('逐档渲染快照：内置/MCP、停用/需授权、确认原因都来自 IPC 返回', async () => {
    stubPocketai({ getToolPolicy: () => snapshot })
    mountWithProviders(<ToolPolicyDialog onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('fs_read')).toBeTruthy())
    expect(screen.getByText('fs_write')).toBeTruthy()
    expect(screen.getAllByText('自动执行').length).toBeGreaterThan(0)
    expect(screen.getAllByText('需要批准').length).toBeGreaterThan(0)
    expect(screen.getByText('写入工作区文件')).toBeTruthy()
    // 停用与“需逐条授权”不是同一个“关闭”
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0)
    expect(screen.getByText('需逐条授权')).toBeTruthy()
    expect(screen.getByText('终端工具当前未启用，模型看不到它；下方规则仍按注册表展示')).toBeTruthy()
    // 终端规则同样按快照里的码渲染；ONLY_FROM_SNAPSHOT 在屏里没有本地名单，只能来自返回对象
    expect(screen.getByText('删除文件（含 git clean -f）')).toBeTruthy()
    expect(screen.getByText('tp.reason.ONLY_FROM_SNAPSHOT')).toBeTruthy()
    expect(screen.getByText('格式化磁盘')).toBeTruthy()
    expect(screen.getByText('* 只覆盖内置工具，MCP 工具必须逐条勾选；勾选后仍按各自判定执行')).toBeTruthy()
    expect(screen.getByText('这不是权限编辑器：要改开关请回到工具配置')).toBeTruthy()
  })

  it('读取失败给原因与重试，不把空表当“没有工具”', async () => {
    const getToolPolicy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'db busy' })
      .mockResolvedValueOnce(snapshot)
    stubPocketai({ getToolPolicy })
    mountWithProviders(<ToolPolicyDialog onClose={() => {}} />)

    await waitFor(() => expect(screen.getByText('工具策略读取失败：db busy')).toBeTruthy())
    screen.getByText('重试').click()
    await waitFor(() => expect(screen.getByText('fs_read')).toBeTruthy())
  })
})
