// @vitest-environment jsdom
// P4 批次 0：会话级统计在对话页的等价入口
//
// 断言：
// · 入口在顶部模型栏右侧（`chat-session-stats`），没有运行且没有失败时整块不出现；
// · 点开后读的是 `agent:get-session-stats` 的同一份聚合——总次数 / 总步数 / 总耗时 / 总 token
//   都在一行里；含子代理时补一句口径说明；
// · 读不到时不让旧数字站台：转警示色，展开后一句话点名 + 重试。
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { fireEvent, screen } from '@testing-library/react'
import type { AgentSessionStats, AssistantRecord, ChatTarget } from '../src/shared/types'
import { ChatView } from '../src/renderer/src/modules/chat/ChatView'
import { zh } from '../src/renderer/src/i18n/zh'
import { mountWithProviders, stubPocketai } from './helpers/renderer'

const targets: ChatTarget[] = [{ providerId: 'p1', model: 'm1' }] as ChatTarget[]
const assistant = { id: 'a1', name: 'a1' } as unknown as AssistantRecord

function mount(over: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  stubPocketai({ getUsagePricing: () => ({}) })
  return mountWithProviders(
    <ChatView
      providers={[]}
      targets={targets}
      onTargetsChange={() => { /* 本组不断言目标改写 */ }}
      messages={[]}
      liveColumns={null}
      assistant={assistant}
      onAssistantUpdated={() => { /* 同上 */ }}
      onSend={() => { /* 同上 */ }}
      onStop={() => { /* 同上 */ }}
      onRegenerate={() => { /* 同上 */ }}
      onResend={() => { /* 同上 */ }}
      onDeleteMessage={() => { /* 同上 */ }}
      onDeleteMessages={() => { /* 同上 */ }}
      onRetrySessionStats={() => { /* 用例按需覆盖 */ }}
      {...over}
    />
  )
}

describe('P4 批次 0：对话页会话级统计入口', () => {
  it('没有运行、也没有读失败：入口整块不出现', () => {
    mount({ sessionStats: null, sessionStatsUnread: null })
    expect(screen.queryByTestId('chat-session-stats')).toBeNull()
  })

  it('点开给出总次数 / 总步数 / 总耗时 / 总 token', () => {
    const stats: AgentSessionStats = { runCount: 2, totalDurationMs: 1200, totalTokens: 40, totalSteps: 3 }
    mount({ sessionStats: stats })
    fireEvent.click(screen.getByTestId('chat-session-stats'))
    const panel = screen.getByTestId('chat-session-stats-panel')
    expect(panel.textContent).toContain('2 次运行')
    expect(panel.textContent).toContain('3 步')
    expect(panel.textContent).toContain('1.2s')
    expect(panel.textContent).toContain('40 tokens')
    expect(screen.queryByText(zh['agent.runStatsSemantics'])).toBeNull()
  })

  it('含子代理时补一句口径：token 含子代理那一趟、步数与耗时只算主干', () => {
    const stats: AgentSessionStats = {
      runCount: 1, totalDurationMs: 800, totalTokens: 100, totalSteps: 2, childRuns: 1
    }
    mount({ sessionStats: stats })
    fireEvent.click(screen.getByTestId('chat-session-stats'))
    expect(screen.getByText(zh['agent.runStatsSemantics'])).toBeTruthy()
  })

  it('读不到时点名并给重试；重试走宿主回调', () => {
    const onRetry = vi.fn()
    mount({ sessionStats: null, sessionStatsUnread: 'boom', onRetrySessionStats: onRetry })
    fireEvent.click(screen.getByTestId('chat-session-stats'))
    expect(screen.getByRole('alert').textContent).toContain('会话累计统计读不到')
    expect(screen.getByRole('alert').textContent).toContain('boom')
    fireEvent.click(screen.getByTestId('chat-session-stats-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
