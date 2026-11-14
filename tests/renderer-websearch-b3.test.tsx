// @vitest-environment jsdom
// 联网搜索 Key 在 none 模式下的写入闸（SEC-1：与渠道同一口径，主进程硬拒）
//
// 这一条测的是**挂接**：拦截发生在 useAgentToolConfigs 里、由 AgentToolBars 显示 toast，
// 只测纯函数测不出「输入框还在，用户能不能看到原因」。所以挂真 hook + 真组件，只桩 IPC。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentToolBars } from '../src/renderer/src/modules/chat/AgentToolBars'
import { useAgentToolConfigs } from '../src/renderer/src/modules/chat/useAgentToolConfigs'

const BLOCKED =
  '未设置主密码，这条凭据不会被保存。请先在「设置 → 数据与安全」中设置主密码后重试；已有凭据仍可读取或删除。'

const setWebSearchConfig = vi.fn()

function mount(mode: 'none' | 'db'): void {
  stubPocketai({
    getEncryptionStatus: () => ({
      mode, unlocked: true, dbEncrypted: mode === 'db', fieldEncrypted: true,
      masterPasswordVerified: mode === 'db', kdfN: mode === 'db' ? 131072 : null, kdfAtCurrentTier: mode === 'db'
    }),
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getCalendarConfig: () => ({ enabled: false, paths: [] }),
    getWebSearchConfig: () => ({
      enabled: true, provider: 'tavily', apiKey: '', hasKey: false,
      searxngBaseUrl: '', searxngAllowPrivate: false, depth: 'auto'
    }),
    setWebSearchConfig: (patch: { apiKey?: string; depth?: string }) => {
      setWebSearchConfig(patch)
      return Promise.resolve({
        enabled: true, provider: 'tavily', apiKey: '', hasKey: true,
        searxngBaseUrl: '', searxngAllowPrivate: false, depth: 'auto', ...patch
      })
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
  // §399②b：那三行不再有「先点开展开」那一步——收起的活归「+」菜单那一行，AgentToolBars 只留控件本体
}

const keyInput = (): HTMLInputElement =>
  screen.getByPlaceholderText('输入 API Key') as HTMLInputElement

/** 按标签取「搜索深度」下拉（列表里还有 shell 策略/provider 两个下拉，按序号取会随布局漂移） */
const depthSelect = (): HTMLSelectElement =>
  screen.getByText('搜索深度').parentElement!.querySelector('select') as HTMLSelectElement

beforeEach(() => {
  setWebSearchConfig.mockClear()
})

describe('联网搜索 Key 在 none 模式下不落库', () => {
  it('none 模式：不发 IPC，给出指路文案', async () => {
    mount('none')
    fireEvent.change(keyInput(), { target: { value: 'tvly-new-key' } })
    fireEvent.keyDown(keyInput(), { key: 'Enter' })
    await waitFor(() => expect(screen.queryByText(BLOCKED)).toBeTruthy())
    expect(setWebSearchConfig).not.toHaveBeenCalled()
  })

  it('db 模式照常保存，不出现拦截文案', async () => {
    mount('db')
    fireEvent.change(keyInput(), { target: { value: 'tvly-fine' } })
    fireEvent.keyDown(keyInput(), { key: 'Enter' })
    await waitFor(() => expect(setWebSearchConfig).toHaveBeenCalledTimes(1))
    expect(setWebSearchConfig.mock.calls[0]?.[0]).toEqual({ apiKey: 'tvly-fine' })
    expect(screen.queryByText(BLOCKED)).toBeNull()
  })
})

describe('搜索深度三档（默认 auto）', () => {
  it('渲染三档并默认选中 auto', () => {
    mount('db')
    const sel = depthSelect()
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(['auto', 'quick', 'deep'])
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      '自动（跟随模型）',
      '快速（标题+摘要）',
      '深度（补读正文）'
    ])
    expect(sel.value).toBe('auto')
  })

  it('切到 deep 落库 {depth:"deep"}', async () => {
    mount('db')
    fireEvent.change(depthSelect(), { target: { value: 'deep' } })
    await waitFor(() => expect(setWebSearchConfig).toHaveBeenCalledWith({ depth: 'deep' }))
  })

  it('选 deep 时行内说明显示耗时/配额提示', async () => {
    mount('db')
    fireEvent.change(depthSelect(), { target: { value: 'deep' } })
    await waitFor(() =>
      expect(screen.getByText(/深度模式并行扩展 3 路检索并补读前 3 条正文/)).toBeTruthy()
    )
  })
})
