// @vitest-environment jsdom
// P4 批次 0 / V4-Iter-461：运行中排队 / 插队迁入对话壳（Composer 侧）
//
// 三条底线：
// · 排队条只在有项时出现，项上的「插队中」不可撤回（那句话随时可能落库）；
// · 运行中只有「允许调用工具」的会话给出入队/插队两键，普通对话仍是原来的单停止键；
// · 运行中回车等同「入队」，附件不能排队时必须明说（不静默丢弃）。
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { Composer } from '../src/renderer/src/modules/chat/Composer'
import type { AgentQueueItem } from '../src/renderer/src/modules/chat/queue-settlement'

/** agentMode=true 会挂载工具配置块（P4 批次 0）⇒ 这些用例需要预置四发读数 */
const stubToolReads = (extra: Record<string, unknown> = {}): void => {
  stubPocketai({
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({ enabled: false, policy: 'confirm' }),
    getWebSearchConfig: () => ({
      enabled: false,
      provider: 'tavily',
      apiKey: '',
      hasKey: false,
      searxngBaseUrl: '',
      searxngAllowPrivate: false,
      depth: 'auto'
    }),
    getCalendarConfig: () => ({ enabled: false, paths: [] }),
    ...extra
  })
}

const item = (clientRef: string, interjecting = false): AgentQueueItem => ({
  clientRef,
  conversationId: 'conv-1',
  text: `排队消息 ${clientRef}`,
  interjecting
})

function mount(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return mountWithProviders(
    <Composer
      streaming={false}
      canSend
      onSend={() => { /* 由各用例断言 */ }}
      onStop={() => { /* 同上 */ }}
      draftKey="conv-1"
      {...over}
    />
  )
}

describe('P4 批次 0：对话壳运行中排队 / 插队', () => {
  it('排队条按项渲染；插队中的项不能撤回，普通项可以', () => {
    stubPocketai()
    const onDropQueued = vi.fn()
    mount({ queue: [item('q1'), item('q2', true)], onDropQueued })
    expect(screen.getByTestId('chat-queue-bar')).toBeTruthy()
    expect(screen.getByTestId('chat-queue-state-q2')).toBeTruthy()
    expect(screen.getByTestId('chat-queue-send-q1')).toBeTruthy()
    expect(screen.queryByTestId('chat-queue-send-q2')).toBeNull()
    fireEvent.click(screen.getByTestId('chat-queue-drop-q1'))
    expect(onDropQueued).toHaveBeenCalledWith('q1')
    const disabledDrop = screen.getByTestId('chat-queue-drop-q2') as HTMLButtonElement
    expect(disabledDrop.disabled).toBe(true)
  })

  it('运行中 + 允许调用工具：出现入队/插队两键，输入后入队并清空输入', () => {
    stubToolReads()
    const onQueue = vi.fn()
    mount({ streaming: true, agentMode: true, onQueue })
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '等本轮结束再补一句' } })
    fireEvent.click(screen.getByTestId('chat-queue-enqueue'))
    expect(onQueue).toHaveBeenCalledWith('等本轮结束再补一句')
    expect(input.value).toBe('')
  })

  it('运行中回车等同入队（插队仍由按钮触发）', () => {
    stubToolReads()
    const onQueue = vi.fn()
    const onInterject = vi.fn()
    mount({ streaming: true, agentMode: true, onQueue, onInterject })
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '回车入队' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onQueue).toHaveBeenCalledWith('回车入队')
    expect(onInterject).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '按钮插队' } })
    fireEvent.click(screen.getByTestId('chat-queue-interject'))
    expect(onInterject).toHaveBeenCalledWith('按钮插队')
  })

  it('普通对话运行中不出现排队键（保持原来的单停止键）', () => {
    stubPocketai()
    mount({ streaming: true, agentMode: false })
    expect(screen.queryByTestId('chat-queue-enqueue')).toBeNull()
    expect(screen.queryByTestId('chat-queue-interject')).toBeNull()
    expect(screen.getByText('停止')).toBeTruthy()
  })

  it('空闲时排队条上的按钮是「发送」，点它交给宿主立即发出', () => {
    stubPocketai()
    const onSendQueuedNow = vi.fn()
    mount({ queue: [item('q3')], onSendQueuedNow })
    fireEvent.click(screen.getByTestId('chat-queue-send-q3'))
    expect(onSendQueuedNow).toHaveBeenCalledWith('q3')
  })
})

describe('P4 批次 0：工具策略总览迁入对话壳', () => {
  it('开启「允许调用工具」后出现策略入口；点开按当前助手视角读取快照', async () => {
    stubToolReads({
      getToolPolicy: () => ({
        tools: [],
        shell: { enabled: true, policy: 'confirm', denyReasons: [], confirmReasons: [] },
        mcpStoppedServers: 0
      })
    })
    mount({ agentMode: true, assistantId: 'asst-1', onToggleAgentMode: () => { /* 开关本身另有注入用例 */ } })
    fireEvent.click(screen.getByTestId('chat-tool-policy-open'))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    // 视角跟随当前助手，而不是注册表全量
    expect(pocketaiCalls().some((c) => c.fn === 'getToolPolicy' && c.args[0] === 'asst-1')).toBe(true)
    // 只读：没有任何写策略的通道被调用
    expect(pocketaiCalls().some((c) => /setToolPolicy|updateToolPolicy/.test(c.fn))).toBe(false)
  })

  it('未开启时不给入口（普通对话不出现工具策略）', () => {
    stubPocketai()
    mount({ agentMode: false, onToggleAgentMode: () => { /* 关闭态 */ } })
    expect(screen.queryByTestId('chat-tool-policy-open')).toBeNull()
  })
})
