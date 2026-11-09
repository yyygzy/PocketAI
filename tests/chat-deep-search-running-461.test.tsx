// @vitest-environment jsdom
// V4-Iter-461：「深度检索中…」随 Agent 壳并入对话壳后恢复
//
// 判定只有一份实现（`chat/useDeepSearchRunning.ts`）：
// · 纯函数 `judgeDeepSearchRunning` 覆盖三档语义（deep 亮 / quick 灭 / auto 看末步 `deepSearch`），
//   以及非运行、非 tool_call、非 web_search 的熄灭；
// · hook 额外约束「只有 Agent 模式 + 运行中 + 末步 web_search 才读联网搜索配置」，
//   其余场景一律 false 且不发 IPC；读失败按 auto 兜底；
// · ChatView 只做一次判定并原样传给 `AgentLiveStepStrip`（组件入参口径未变）。
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderHook, screen, waitFor } from '@testing-library/react'
import type { AssistantRecord, ChatTarget, WebSearchConfig } from '../src/shared/types'
import { ChatView } from '../src/renderer/src/modules/chat/ChatView'
import {
  judgeDeepSearchRunning,
  useDeepSearchRunning
} from '../src/renderer/src/modules/chat/useDeepSearchRunning'
import type { AgentMessage, LiveStep } from '../src/renderer/src/modules/agent/agent-shared'
import { zh } from '../src/renderer/src/i18n/zh'
import { HookProviders, calledFns, mountWithProviders, stubPocketai } from './helpers/renderer'

// ChatView 的实时卡片挂在虚拟列表里；jsdom 没有布局尺寸，真实 virtualizer 不会产出可视项。
// 这里只替换虚拟化本身（每一项都"可见"），ChatView 与步骤条的真实接线保持原样。
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 200,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 200, size: 200, key: i })),
    measureElement: () => { /* jsdom 无布局，高度不参与本组断言 */ },
    scrollToIndex: () => { /* 同上：滚动意图不参与本组断言 */ }
  })
}))

const webSearchStep = (over: Partial<LiveStep> = {}): LiveStep => ({
  stepIndex: 1,
  type: 'tool_call',
  toolName: 'web_search',
  ...over
})

const wsConfig = (depth: WebSearchConfig['depth']): WebSearchConfig => ({
  enabled: true,
  provider: 'tavily',
  apiKey: '',
  hasKey: true,
  searxngBaseUrl: '',
  searxngAllowPrivate: false,
  depth
})

describe('judgeDeepSearchRunning：三档只看末步与档位', () => {
  it('deep：运行中且末步是 web_search 就亮（不看模型是否自己传了 depth）', () => {
    expect(judgeDeepSearchRunning(true, webSearchStep(), 'deep')).toBe(true)
    expect(judgeDeepSearchRunning(true, webSearchStep({ deepSearch: false }), 'deep')).toBe(true)
  })

  it('quick：即使模型自己传了 depth=deep 也灭', () => {
    expect(judgeDeepSearchRunning(true, webSearchStep({ deepSearch: true }), 'quick')).toBe(false)
  })

  it('auto：跟随末步 deepSearch（模型给 web_search 传了 depth=deep 才亮）', () => {
    expect(judgeDeepSearchRunning(true, webSearchStep({ deepSearch: true }), 'auto')).toBe(true)
    expect(judgeDeepSearchRunning(true, webSearchStep({ deepSearch: false }), 'auto')).toBe(false)
    expect(judgeDeepSearchRunning(true, webSearchStep(), 'auto')).toBe(false)
  })

  it('非运行 / 无末步 / 非 tool_call / 非 web_search 都不亮', () => {
    expect(judgeDeepSearchRunning(false, webSearchStep({ deepSearch: true }), 'deep')).toBe(false)
    expect(judgeDeepSearchRunning(true, undefined, 'deep')).toBe(false)
    expect(judgeDeepSearchRunning(true, { stepIndex: 1, type: 'thought' }, 'deep')).toBe(false)
    expect(judgeDeepSearchRunning(true, webSearchStep({ toolName: 'read_file' }), 'deep')).toBe(false)
    expect(
      judgeDeepSearchRunning(true, { stepIndex: 1, type: 'tool_result', toolName: 'web_search' }, 'deep')
    ).toBe(false)
  })
})

describe('useDeepSearchRunning：只在候选态读配置', () => {
  const run = (agentMode: boolean, running: boolean, steps?: LiveStep[]) =>
    renderHook(() => useDeepSearchRunning({ agentMode, running, steps }), { wrapper: HookProviders })

  it('agentMode=false 时不参与，也不发配置读取', () => {
    stubPocketai({})
    const { result } = run(false, true, [webSearchStep()])
    expect(result.current).toBe(false)
    expect(calledFns()).not.toContain('getWebSearchConfig')
  })

  it('非运行 / 末步不是 web_search 时不发配置读取', () => {
    stubPocketai({})
    const stopped = run(true, false, [webSearchStep()])
    expect(stopped.result.current).toBe(false)
    const otherTool = run(true, true, [webSearchStep({ toolName: 'read_file' })])
    expect(otherTool.result.current).toBe(false)
    expect(calledFns()).not.toContain('getWebSearchConfig')
  })

  it('deep 档：候选态亮（配置异步回来后）', async () => {
    stubPocketai({ getWebSearchConfig: () => wsConfig('deep') })
    const { result } = run(true, true, [webSearchStep()])
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('quick 档：模型传了 depth=deep 也灭', async () => {
    stubPocketai({ getWebSearchConfig: () => wsConfig('quick') })
    const { result } = run(true, true, [webSearchStep({ deepSearch: true })])
    await waitFor(() => expect(calledFns()).toContain('getWebSearchConfig'))
    expect(result.current).toBe(false)
  })

  it('auto 档：末步 deepSearch=true 才亮', async () => {
    stubPocketai({ getWebSearchConfig: () => wsConfig('auto') })
    const { result } = run(true, true, [webSearchStep({ deepSearch: true })])
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('auto 档：末步没带 deepSearch 就灭（配置读到了也不亮）', async () => {
    stubPocketai({ getWebSearchConfig: () => wsConfig('auto') })
    const { result } = run(true, true, [webSearchStep({ deepSearch: false })])
    await waitFor(() => expect(calledFns()).toContain('getWebSearchConfig'))
    expect(result.current).toBe(false)
  })

  it('读配置失败按 auto 兜底：不阻断提示，也不假装 deep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 失败面由日志承载 */ })
    try {
      stubPocketai({ getWebSearchConfig: () => Promise.reject(new Error('boom')) })
      const { result } = run(true, true, [webSearchStep({ deepSearch: true })])
      await waitFor(() => expect(result.current).toBe(true))
    } finally {
      warn.mockRestore()
    }
  })
})

const targets: ChatTarget[] = [{ providerId: 'p1', model: 'm1' }] as ChatTarget[]
const assistant = { id: 'a1', name: 'a1' } as unknown as AssistantRecord
const liveCard: AgentMessage[] = [{ id: 'live-1', role: 'assistant', text: '检索中' }]

function mountChat(over: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  return mountWithProviders(
    <ChatView
      providers={[]}
      targets={targets}
      onTargetsChange={() => { /* 本组不断言目标改写 */ }}
      messages={[]}
      liveColumns={null}
      streaming
      agentMode
      liveSteps={[webSearchStep()]}
      agentLive={liveCard}
      assistant={assistant}
      onAssistantUpdated={() => { /* 同上 */ }}
      onSend={() => { /* 同上 */ }}
      onStop={() => { /* 同上 */ }}
      onRegenerate={() => { /* 同上 */ }}
      onResend={() => { /* 同上 */ }}
      onDeleteMessage={() => { /* 同上 */ }}
      onDeleteMessages={() => { /* 同上 */ }}
      {...over}
    />
  )
}

/** agentMode=true 时 Composer 会挂工具配置（挂载即读四发配置），本组把这几发一并置上 */
function stubChat(depth: WebSearchConfig['depth']): void {
  stubPocketai({
    getUsagePricing: () => ({}),
    getWebSearchConfig: () => wsConfig(depth),
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getCalendarConfig: () => ({ enabled: false, paths: [] })
  })
}

describe('ChatView：判定一次并原样传给步骤条', () => {
  it('deep 档亮出「深度检索中…」', async () => {
    stubChat('deep')
    mountChat()
    expect(await screen.findByText(zh['agent.websearch.deepRunning'])).toBeTruthy()
  })

  it('quick 档不亮（配置已读到，仍熄灭）', async () => {
    stubChat('quick')
    mountChat()
    await waitFor(() => expect(calledFns()).toContain('getWebSearchConfig'))
    expect(screen.queryByText(zh['agent.websearch.deepRunning'])).toBeNull()
  })

  it('auto 档跟随末步 deepSearch：没带 deep 不亮', async () => {
    stubChat('auto')
    mountChat({ liveSteps: [webSearchStep({ deepSearch: false })] })
    await waitFor(() => expect(calledFns()).toContain('getWebSearchConfig'))
    expect(screen.queryByText(zh['agent.websearch.deepRunning'])).toBeNull()
  })

  it('agentMode=false 时不参与：不读配置、也不亮', () => {
    stubPocketai({ getUsagePricing: () => ({}) })
    mountChat({ agentMode: false })
    expect(calledFns()).not.toContain('getWebSearchConfig')
    expect(screen.queryByText(zh['agent.websearch.deepRunning'])).toBeNull()
  })
})
