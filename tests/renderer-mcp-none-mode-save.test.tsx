// @vitest-environment jsdom
// MCP 表单对「主进程闸门拒绝」的呈现（SEC-1 B2）
//
// 闸门在 repo 里抛错，safeHandle 转成 { ok:false, error } 结构化失败——不是异常。
// 修之前这条通路会被当成保存成功（表单照常回调 onSaved，列表里多出一条库里没有的记录），
// 用例钉住两点：拒绝文案要显示出来、拒绝时不得走成功回调；以及判定权确实在主进程。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import React from 'react'
import type { McpServerRecord } from '../src/shared/types'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { McpForm } from '../src/renderer/src/modules/agent/mcp/McpForm'

const BLOCK_MSG =
  '未设置主密码，新密钥不会被保存（env：API_KEY）。请先在「设置 → 数据加密」中设置主密码后重试。'

let onSaved: ReturnType<typeof vi.fn>

function mount(initial: Partial<McpServerRecord>): void {
  mountWithProviders(<McpForm initial={initial} onCancel={() => {}} onSaved={onSaved} />)
}

async function clickSave(): Promise<void> {
  fireEvent.click(screen.getByText('保存').closest('button') as HTMLElement)
  await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'saveMcpServer')).toBe(true))
}

beforeEach(() => {
  onSaved = vi.fn()
  stubPocketai({ saveMcpServer: () => ({ ok: false, error: BLOCK_MSG }) })
})

describe('McpForm 处理 none 模式闸门拒绝', () => {
  it('拒绝文案就地展示，成功回调不触发', async () => {
    mount({ name: 'demo', transport: 'stdio', command: 'node' })
    await clickSave()
    await waitFor(() => expect(screen.getByText(BLOCK_MSG)).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('保存成功（返回记录）时照常回调', async () => {
    const rec: McpServerRecord = {
      id: 'srv-1',
      name: 'demo',
      transport: 'stdio',
      runtime: 'binary',
      command: 'node',
      args: [],
      env: {},
      url: null,
      enabled: true,
      createdAt: 0,
      pythonPackages: [],
      headers: {},
      trustReadOnly: false
    }
    stubPocketai({ saveMcpServer: () => rec })
    mount({ name: 'demo', transport: 'stdio', command: 'node' })
    await clickSave()
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(BLOCK_MSG)).toBeNull()
  })

  it('表单原样提交用户填写的 env，是否放行由主进程判定', async () => {
    // 编辑既有记录：env 是掩码视图，用户把值改成真实新密钥
    stubPocketai({
      saveMcpServer: () => ({ ok: false, error: BLOCK_MSG }),
      revealMcpSecrets: () => ({ ok: true, env: { API_KEY: '••••cdef' }, headers: {} }),
      // 带 id 挂载时 usePythonEnv 会订阅安装事件（返回卸载函数）
      onPythonEnvEvent: () => () => {}
    })
    mount({ id: 'srv-1', name: 'demo', transport: 'stdio', command: 'node', env: { API_KEY: '••••cdef' } })
    const envBox = screen.getByDisplayValue(/API_KEY/) as HTMLTextAreaElement
    fireEvent.change(envBox, { target: { value: '{"API_KEY":"sk-brand-new"}' } })
    await clickSave()
    const call = pocketaiCalls().find((c) => c.fn === 'saveMcpServer')
    expect((call?.args[0] as { env: Record<string, string> }).env).toEqual({ API_KEY: 'sk-brand-new' })
    await waitFor(() => expect(screen.getByText(BLOCK_MSG)).toBeTruthy())
  })
})
