// @vitest-environment jsdom
// 联网搜索 Key 的 B3 确认（与渠道同一口径：不拦写入，但新值要承认）
//
// 这一条测的是**挂接**：确认弹层由 useAgentToolConfigs 持有、由 AgentToolBars 渲染，
// 少渲染一个 {secretDialog} 就会变成「点了没反应」的死锁——纯函数用例测不出来。
// 所以这里挂真 hook + 真组件，只桩 IPC。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentToolBars } from '../src/renderer/src/modules/agent/components/AgentToolBars'
import { useAgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'

const WARN =
  '当前未设置主密码：这条凭据只会用源码中公开的固定密钥做本地混淆，拿到本机数据目录的人可以还原。确认仍要保存？'

const setWebSearchConfig = vi.fn()

function mount(mode: 'none' | 'db'): void {
  stubPocketai({
    getEncryptionStatus: () => ({
      mode, unlocked: true, dbEncrypted: mode === 'db', fieldEncrypted: true,
      masterPasswordVerified: true, kdfN: null, kdfAtCurrentTier: true
    }),
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getCalendarConfig: () => ({ enabled: false, paths: [] }),
    getWebSearchConfig: () => ({ enabled: true, provider: 'tavily', apiKey: '', hasKey: false }),
    setWebSearchConfig: (patch: { apiKey?: string }) => {
      setWebSearchConfig(patch)
      return Promise.resolve({ enabled: true, provider: 'tavily', apiKey: '', hasKey: true })
    },
    setShellConfig: () => ({}),
    setCalendarConfig: () => ({}),
    pickIcsFile: () => ({ canceled: true })
  })
  const Harness: React.FC = () => {
    const tools = useAgentToolConfigs()
    return <AgentToolBars tools={tools} />
  }
  mountWithProviders(<Harness />)
  // 工具栏默认收起，先展开
  // 收起态的「工具配置」在按钮与其 title 节点上各出现一次 ⇒ 取第一个并点上层的按钮
  fireEvent.click(screen.getAllByText('工具配置')[0]!.closest('button') as HTMLElement)
}

const keyInput = (): HTMLInputElement =>
  screen.getByPlaceholderText('输入 API Key') as HTMLInputElement

beforeEach(() => {
  setWebSearchConfig.mockClear()
})

describe('联网搜索 Key 的 B3 承认', () => {
  it('none 模式：确认前不落库，点确认后写入一次', async () => {
    mount('none')
    fireEvent.change(keyInput(), { target: { value: 'tvly-new-key' } })
    fireEvent.keyDown(keyInput(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByText(WARN)).toBeTruthy())
    expect(setWebSearchConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => expect(setWebSearchConfig).toHaveBeenCalledTimes(1))
    expect(setWebSearchConfig.mock.calls[0]?.[0]).toEqual({ apiKey: 'tvly-new-key' })
  })

  it('none 模式点取消：不写入', async () => {
    mount('none')
    fireEvent.change(keyInput(), { target: { value: 'tvly-cancel-me' } })
    fireEvent.keyDown(keyInput(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByText(WARN)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByText(WARN)).toBeNull())
    expect(setWebSearchConfig).not.toHaveBeenCalled()
  })

  it('db 模式不多弹一次', async () => {
    mount('db')
    fireEvent.change(keyInput(), { target: { value: 'tvly-fine' } })
    fireEvent.keyDown(keyInput(), { key: 'Enter' })
    await waitFor(() => expect(setWebSearchConfig).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(WARN)).toBeNull()
  })
})
