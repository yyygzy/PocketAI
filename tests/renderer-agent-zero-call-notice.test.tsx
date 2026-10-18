// 零调用提示的界面契约 + 「文本协议」开关的作用域复位（B54 提示行 / B55④ 的界面那一半）
// @vitest-environment jsdom
//
// 为什么要这条：B54 那条「本次有 N 个 MCP 工具未授权」此前只有 CI 里的**计数**
// （`agent-mcp-held-back.test.ts` 证的是数字对不对），没人证过它**渲染出来是什么**——
// 数字插值写错、或者两条「为什么」同时出现在屏幕上，计数用例都是绿的。
// 另一半是 B55④：开关的作用域是 provider+model 一台一个，切到另一台模型时徽标必须复位；
// 这属于 hook 的状态推导，跟徽标渲染（另一份用例）不是一回事，所以在这里测 hook。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, stubPocketai, pocketaiCalls, HookProviders } from './helpers/renderer'
import { ZeroToolCallNotice } from '../src/renderer/src/modules/agent/components/ZeroToolCallNotice'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const heldLine = (n: number) => zh['agent.mcpHeldBackHint'].replace('{count}', String(n))

function mountNotice(props: Partial<React.ComponentProps<typeof ZeroToolCallNotice>> = {}) {
  const onClose = vi.fn()
  const onEnable = vi.fn()
  mountWithProviders(
    <ZeroToolCallNotice
      mcpHeldBack={0}
      providerId="p1"
      model="m1"
      textProtocolForced={false}
      onClose={onClose}
      onEnableTextProtocol={onEnable}
      {...props}
    />
  )
  return { onClose, onEnable }
}

beforeEach(() => {
  stubPocketai({})
})

describe('零调用提示（ZeroToolCallNotice）', () => {
  it('主提示行始终在，两条「为什么」都挂在它下面', () => {
    mountNotice()
    expect(screen.getByText(zh['agent.noToolCallNotice'])).toBeTruthy()
  })

  it('有 MCP 被挡：渲染带真实数字的那一行，且**不再**出现「改用文本协议」的建议', () => {
    mountNotice({ mcpHeldBack: 3 })
    // 逐字比对（含 {count} 插值）：写成「本次有 个 …」这类丢数字的错必须红
    expect(screen.getByText(heldLine(3))).toBeTruthy()
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()
  })

  it('没有工具被挡、开关未开：才出现建议，点一下走的是「开当前这台模型」', () => {
    const { onEnable } = mountNotice()
    const btn = screen.getByText(zh['agent.textProtocolSuggest'])
    expect(screen.queryByText(heldLine(0))).toBeNull()
    fireEvent.click(btn)
    expect(onEnable).toHaveBeenCalledTimes(1)
  })

  it('开关已经开着时不重复建议（否则用户会以为点一下是再开一次）', () => {
    mountNotice({ textProtocolForced: true })
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()
  })

  it('还没选到服务商/模型时也不建议（那时根本没有可点名的目标）', () => {
    mountNotice({ providerId: '' })
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()
    mountNotice({ model: '' })
    expect(screen.queryByText(zh['agent.textProtocolSuggest'])).toBeNull()
  })

  it('提示语指的是**真能点到的路径**：内置助手要先「复制为我的助手」', () => {
    // 这条不是文案审美，是口径：Iter-110 之后 `'*'` 不含 MCP，而内置助手在数据层就被
    // `assistant.repo.ts:128` 硬挡（不可编辑，只能复制）。上一版提示语让人去「助手 → 工具权限」
    // 逐个勾选——对内置助手那是条不存在的路，等于把用户支到一个找不到的地方。
    const hint = zh['agent.mcpHeldBackHint']
    expect(hint).toContain('{count}')
    expect(hint).toContain(zh['am.copy'])
    expect(hint).toContain(zh['ae.groupMcp'])
    expect(hint).not.toContain('助手 → 工具权限')
  })

  it('✕ 真的能关掉（常驻骚扰没有出口是不允许的）', () => {
    const { onClose } = mountNotice()
    fireEvent.click(screen.getByText('✕'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('B55④：开关作用域在 hook 状态里是一台模型一个', () => {
  const PROVIDERS = [
    { id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models: ['gpt-mini', 'gpt-max'] }
  ] as unknown as ProviderRecord[]
  const assistants = [
    { id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }
  ] as unknown as AssistantRecord[]
  const conv = { id: 'c1', assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord

  function mountHook(forced: string[]) {
    stubPocketai({
      getUiPrefs: () => ({ ok: true, data: {} }),
      setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
      listConversations: () => [conv],
      listMessages: () => [],
      getLatestRunStats: () => null,
      getSessionStats: () => null,
      getAgentTextProtocol: () => forced,
      // 通道签名是**三个位置参数**（providerId, model, on），回传库里最新的清单（不做乐观更新）
      setAgentTextProtocol: (pid: string, mdl: string, on: boolean) => {
        const key = `${pid}::${mdl}`
        forced = on ? Array.from(new Set([...forced, key])) : forced.filter((k) => k !== key)
        return forced
      },
      onAgentStep: () => () => {},
      onAgentChunk: () => () => {},
      onAgentDone: () => () => {},
      onAgentError: () => () => {},
      onConversationTitle: () => () => {}
    })
    const { result } = renderHook(() => useAgentChat(PROVIDERS, assistants), {
      wrapper: HookProviders
    })
    return result
  }

  it('点名了 gpt-mini ⇒ 选它时 forced=true，切到 gpt-max 立刻复位 false', async () => {
    const result = mountHook(['p1::gpt-mini'])
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'getAgentTextProtocol')).toBe(true))
    act(() => result.current.changeProvider('p1'))
    act(() => result.current.setModel('gpt-mini'))
    expect(result.current.providerId).toBe('p1')
    expect(result.current.textProtocolForced).toBe(true)
    // 换另一台模型：作用域是 provider+model 一台一个，不能跟着过去
    act(() => result.current.setModel('gpt-max'))
    expect(result.current.textProtocolForced).toBe(false)
  })

  it('通过 setTextProtocol 关掉当前这台 ⇒ 徽标复位，且写库带的是 on=false', async () => {
    const result = mountHook(['p1::gpt-mini'])
    await waitFor(() => expect(pocketaiCalls().some((c) => c.fn === 'getAgentTextProtocol')).toBe(true))
    act(() => result.current.changeProvider('p1'))
    act(() => result.current.setModel('gpt-mini'))
    expect(result.current.textProtocolForced).toBe(true)
    await act(async () => {
      await result.current.setTextProtocol(false)
    })
    expect(result.current.textProtocolForced).toBe(false)
    const write = pocketaiCalls().find((c) => c.fn === 'setAgentTextProtocol')
    expect(write?.args).toEqual(['p1', 'gpt-mini', false])
  })
})
