// @vitest-environment jsdom
// P4 批次 0 / V4-Iter-461：工具配置（终端/联网/日历/工作目录）
//
// V4 交互改造后从输入框上方那一行收进「+ → 执行设置」（仅 Agent 模式出现）。断言口径不变：
// · 普通对话（agentMode=false）整块不出现 ⇒ 四发读数一次都不发（不是"隐藏了但仍在读"）；
// · 开启后四发读数齐全，浮层内控件写回仍走既有 `setShellConfig`（无第二份状态）；
// · 某一发读不到时，句子在浮层外面（菜单关着也不闭嘴），且工作目录那一读有同级重试键。
import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import { calledFns, mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'

const shellConfig = { enabled: false, policy: 'confirm' as const }
const wsConfig = {
  enabled: false,
  provider: 'tavily' as const,
  apiKey: '',
  hasKey: false,
  searxngBaseUrl: '',
  searxngAllowPrivate: false,
  depth: 'auto' as const
}
const calConfig = { enabled: false, paths: [] as string[] }

function mount(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return mountWithProviders(
    <Composer
      streaming={false}
      canSend
      onSend={() => { /* 本组不断言发送 */ }}
      onStop={() => { /* 同上 */ }}
      draftKey="conv-1"
      onToggleAgentMode={() => { /* 开关另有注入用例 */ }}
      {...over}
    />
  )
}

const stubToolReads = (over: Record<string, unknown> = {}): void => {
  stubPocketai({
    getAgentWorkspaceDir: () => '/tmp/ws',
    getShellConfig: () => shellConfig,
    getWebSearchConfig: () => wsConfig,
    getCalendarConfig: () => calConfig,
    listPromptSnippets: () => [],
    ...over
  })
}

describe('P4 批次 0：工具配置收进「+ → 执行设置」', () => {
  it('普通对话不出现执行设置，也不发任何工具配置读', () => {
    stubPocketai({ listPromptSnippets: () => [] })
    mount({ agentMode: false })
    fireEvent.click(screen.getByTestId('composer-plus-open'))
    expect(screen.queryByTestId('composer-plus-tools')).toBeNull()
    expect(calledFns()).not.toContain('getShellConfig')
    expect(calledFns()).not.toContain('getAgentWorkspaceDir')
  })

  it('开启后读取四发配置，浮层里改终端开关仍走 setShellConfig', async () => {
    stubToolReads({
      setShellConfig: (patch: Record<string, unknown>) => ({ ...shellConfig, ...patch })
    })
    mount({ agentMode: true })
    // 四发挂载读都在（不需要先打开菜单）
    for (const fn of ['getAgentWorkspaceDir', 'getShellConfig', 'getWebSearchConfig', 'getCalendarConfig']) {
      expect(calledFns()).toContain(fn)
    }
    fireEvent.click(screen.getByTestId('composer-plus-open'))
    fireEvent.click(await screen.findByTestId('composer-plus-tools'))
    await screen.findByLabelText(`🖥 终端命令`)
    const shellToggle = screen.getByLabelText(`🖥 终端命令`)
    fireEvent.click(shellToggle)
    expect(pocketaiCalls().some((c) => c.fn === 'setShellConfig' && (c.args[0] as { enabled?: boolean }).enabled === true)).toBe(true)
  })

  it('工作目录快捷入口与「允许调用工具」同一行，选目录仍走既有 pickAgentWorkspaceDir', async () => {
    stubToolReads({ pickAgentWorkspaceDir: () => '/tmp/next' })
    mount({ agentMode: true })
    const chip = await screen.findByTestId('composer-workspace-chip')
    expect(chip.parentElement?.contains(screen.getByTestId('chat-agent-mode-toggle'))).toBe(true)
    // 窄宽度：外层允许收缩、内层路径可截断（不靠撑破行 / 横向滚动）
    expect(chip.className).toContain('min-w-0')
    expect(chip.className).toContain('max-w-full')
    expect(chip.querySelector('span.truncate')?.className).toContain('min-w-0')
    fireEvent.click(chip)
    expect(pocketaiCalls().some((c) => c.fn === 'pickAgentWorkspaceDir')).toBe(true)
  })

  it('读不到时句子在浮层外：菜单关着也看得见，工作目录带同级重试', async () => {
    stubToolReads({
      getShellConfig: () => ({ ok: false, error: 'boom' }),
      getAgentWorkspaceDir: () => ({ ok: false, error: 'boom-ws' })
    })
    mount({ agentMode: true })
    // 两发都读不到 ⇒ 两条 alert（工作目录 + 终端命令），都应在浮层外
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some((a) => a.textContent?.includes('boom'))).toBe(true)
    expect(screen.queryByTestId('composer-plus-menu')).toBeNull()
    const retry = screen.getByTestId('chat-tool-config-workspace-retry')
    fireEvent.click(retry)
    expect(calledFns().filter((fn) => fn === 'getAgentWorkspaceDir').length).toBeGreaterThan(1)
  })
})
