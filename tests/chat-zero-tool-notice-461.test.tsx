// @vitest-environment jsdom
// P4 批次 0：零调用提示迁入对话壳
//
// 断言三件事：
// · 判定与 Agent 壳共用同一份实现（`shouldShowZeroToolCallNotice`）：
//   本轮没用工具 + 会话从未出现工具卡才亮；本轮用过工具或会话有过工具卡都不亮；
// · 提示渲染复用 `ZeroToolCallNotice`（同一颗 ✕ / 同一条 MCP 被挡说明 / 同一条文本协议建议）；
// · 对话壳只负责把它挂在 Composer 上方，落定前（streaming）不出现。
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { act, fireEvent, renderHook, screen } from '@testing-library/react'
import type { AssistantRecord, ChatTarget } from '../src/shared/types'
import { ChatView } from '../src/renderer/src/modules/chat/ChatView'
import { useZeroToolCallNotice } from '../src/renderer/src/modules/chat/useZeroToolCallNotice'
import { zh } from '../src/renderer/src/i18n/zh'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'

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
      {...over}
    />
  )
}

describe('P4 批次 0：零调用提示迁入对话壳', () => {
  it('提示行复用同一份组件；✕ 走宿主的关闭回调', () => {
    const onClose = vi.fn()
    mount({ noToolCallNotice: true, onCloseNoToolCallNotice: onClose })
    expect(screen.getByText(zh['agent.noToolCallNotice'])).toBeTruthy()
    fireEvent.click(screen.getByText('✕'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('运行中（streaming）不出现：那是"这一轮"的结果，没落定就没有结论', () => {
    mount({ noToolCallNotice: true, streaming: true })
    expect(screen.queryByText(zh['agent.noToolCallNotice'])).toBeNull()
  })

  it('MCP 被挡只说被挡；没被挡且未开文本协议时才给建议并回调宿主', () => {
    const onEnable = vi.fn()
    mount({ noToolCallNotice: true, noToolMcpHeldBack: 2, onEnableTextProtocol: onEnable })
    expect(screen.getByText(zh['agent.mcpHeldBackHint'].replace('{count}', '2'))).toBeTruthy()
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()

    mount({ noToolCallNotice: true, textProtocolForced: true, onEnableTextProtocol: onEnable })
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()

    mount({ noToolCallNotice: true, onEnableTextProtocol: onEnable })
    fireEvent.click(screen.getByText(zh['agent.textProtocolSuggest']))
    expect(onEnable).toHaveBeenCalledTimes(1)
  })

  it('判定与 Agent 壳同源：没用工具且会话无工具卡才亮，用过工具/有过工具卡都不亮', () => {
    stubPocketai({ getUsagePricing: () => ({}) })
    const { result } = renderHook(() => useZeroToolCallNotice(), { wrapper: HookProviders })
    act(() => result.current.applyDone(false, 0, false))
    expect(result.current.visible).toBe(true)
    act(() => result.current.applyDone(false, 3, false))
    expect(result.current.mcpHeldBack).toBe(3)
    act(() => result.current.applyDone(true, 0, false))
    expect(result.current.visible).toBe(false)
    act(() => result.current.applyDone(false, 0, true))
    expect(result.current.visible).toBe(false)
    act(() => result.current.clear())
    expect(result.current.visible).toBe(false)
    expect(result.current.mcpHeldBack).toBe(0)
  })
})
