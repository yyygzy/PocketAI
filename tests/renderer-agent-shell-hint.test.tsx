// @vitest-environment jsdom
// 受限终端提示在截断容器里的可见性（SEC-28 话术 + SEC-Verify-1 修的那条截断缺陷）
//
// AgentToolBars 的这行提示落在 `min-w-0 flex-1 truncate` 容器里 —— 被截断的部分
// 用户永远看不见。上次我把文案写长之后，关键结论「不是沙箱」正好落在中段，
// 界面上等于没说。这里钉两件事：
// 1) 可见文本的**开头**就得是核心结论（截断后仍然说真话）；
// 2) 完整文案挂在 title 上（悬停可见），且与字典逐字相同。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentToolBars } from '../src/renderer/src/modules/agent/components/AgentToolBars'
import type { AgentToolConfigs } from '../src/renderer/src/modules/agent/hooks/useAgentToolConfigs'
import { zh } from '../src/renderer/src/i18n/zh'

function mount(enabled: boolean) {
  stubPocketai()
  const tools = {
    workspaceDir: 'C:/workspace',
    shellConfig: { enabled, policy: 'confirm' },
    wsConfig: { enabled: false, hasKey: false },
    wsKeyDraft: '',
    setWsKeyDraft: () => {},
    pickWorkspace: vi.fn(),
    patchShellConfig: () => {},
    patchWsConfig: () => {},
    patchCalConfig: () => {},
    calConfig: { enabled: false, paths: [] },
    addIcs: () => {}
  } as unknown as AgentToolConfigs
  mountWithProviders(<AgentToolBars tools={tools} />)
  // 工具栏默认收起，先展开。注意别按文本查：三项全关时收起态的摘要会回退成
  // 同一句「工具配置」， getByText 会撞重，直接点第一个按钮即可
  const toggle = document.querySelector('button')
  if (!toggle) throw new Error('AgentToolBars 未渲染出展开按钮')
  fireEvent.click(toggle)
}

function hintSpan(): HTMLElement {
  const el = document.querySelector('span.truncate')
  if (!el) throw new Error('找不到承载终端提示的 truncate span（容器或类名变了，用例要跟着改）')
  return el as HTMLElement
}

describe('受限终端提示的截断可见性', () => {
  it('开启终端时：可见文本以「受限终端·不是沙箱」开头', () => {
    mount(true)
    expect(hintSpan().textContent ?? '').toMatch(/^受限终端·不是沙箱/)
  })

  it('title 挂的是完整文案，且与字典逐字相同', () => {
    mount(true)
    const el = hintSpan()
    expect(el.getAttribute('title')).toBe(zh['agent.shell.hintOn'])
    // 完整文案里必须真的含着两条核心事实（截断时靠它们说话）
    expect(zh['agent.shell.hintOn']).toContain('不是沙箱')
    expect(zh['agent.shell.hintOn']).toContain('起始目录')
    // 全文比可见的开头长 ⇒ 这个容器确实会截断，title 不是装饰
    expect((zh['agent.shell.hintOn'] ?? '').length).toBeGreaterThan(30)
  })

  it('关闭终端时同样有 title，避免收起提示被截断后无线索', () => {
    mount(false)
    const el = hintSpan()
    expect(el.textContent).toBe(zh['agent.shell.hintOff'])
    expect(el.getAttribute('title')).toBe(zh['agent.shell.hintOff'])
  })
})
