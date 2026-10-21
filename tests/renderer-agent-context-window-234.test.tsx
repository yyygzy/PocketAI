// @vitest-environment jsdom
// 模型栏上的「上下文窗口」输入（V4-Iter-234）：三态标签、面板里的两句实话、点下去传什么，
// 以及 useAgentChat 那两条失败面（读不到／写被拒）到底说不说话。
//
// 为什么钉这里：这个控件的默认态有一个恰好合法的假象——"读不到"会演成"没有一台模型设过窗口"，
// 而后者与"未设"在界面上长得一模一样（§222／§226 那一族）。所以第 3 条用例是**负向判据**：
// 读失败时不许出现「窗口未设」那串。
// 另一条更隐蔽：面板里那句"留空按最近的 30 条走"的数字来自共享常量，不来自字典手抄（§153），
// 所以第 4 条断的是渲染出来的串里确实带着那个数。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act, renderHook } from '@testing-library/react'
import { HookProviders, mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentModelBar } from '../src/renderer/src/modules/agent/components/AgentModelBar'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import { zh } from '../src/renderer/src/i18n/zh'
import {
  DEFAULT_MESSAGES_WHEN_WINDOW_UNSET,
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS
} from '../src/shared/model-window'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6']
} as unknown as ProviderRecord

function mountBar(
  opts: {
    providerId?: string
    model?: string
    tokens?: number | null
    unread?: string | null
    onSet?: (tokens: number | null) => void
    withControl?: boolean
  } = {}
) {
  const onSet = opts.onSet ?? vi.fn()
  mountWithProviders(
    <AgentModelBar
      providers={[glm]}
      providerId={opts.providerId ?? 'glm'}
      model={opts.model ?? 'glm-4.6'}
      onProviderChange={() => {}}
      onModelChange={() => {}}
      selectedProvider={glm}
      fetchingModels={false}
      onFetchModels={() => {}}
      workspaceDir=""
      onPickWorkspace={() => {}}
      textProtocolForced={false}
      onToggleTextProtocol={() => {}}
      onSetContextWindow={opts.withControl === false ? undefined : onSet}
      contextWindowTokens={opts.tokens}
      contextWindowUnread={opts.unread}
    />
  )
  return onSet
}

beforeEach(() => {
  stubPocketai({})
})

describe('模型栏上的窗口徽标：三态各说各的', () => {
  it('已设：标签带那个数，悬停说明讲"它决定每轮带多少历史"', () => {
    mountBar({ tokens: 8192 })
    const badge = screen.getByText(zh['agent.windowValue'].replace('{n}', '8192'))
    expect(badge.getAttribute('title')).toBe(zh['agent.windowHint'])
    expect(screen.queryByText(zh['agent.windowUnset'])).toBeNull()
  })

  it('未设：直说「窗口未设」，不给一个看起来像当前值的数', () => {
    mountBar({ tokens: null })
    expect(screen.getByText(zh['agent.windowUnset']).getAttribute('title')).toBe(zh['agent.windowHint'])
    expect(screen.queryByText(zh['agent.windowReadFail'])).toBeNull()
  })

  it('读不到：标签换成「窗口读数取不到」，**不许**演成「窗口未设」（这条是负向判据）', () => {
    mountBar({ tokens: null, unread: '端点没连上' })
    const badge = screen.getByText(zh['agent.windowReadFail'])
    expect(badge.getAttribute('title')).toContain('端点没连上')
    expect(screen.queryByText(zh['agent.windowUnset'])).toBeNull()
  })

  it('没选模型／没接线时，这一颗压根不出现（反向对照：旧挂载不会因为多了这个控件而变化）', () => {
    mountBar({ model: '' })
    expect(screen.queryByText(zh['agent.windowUnset'])).toBeNull()
    mountBar({ withControl: false })
    expect(screen.queryByText(zh['agent.windowUnset'])).toBeNull()
  })
})

describe('点开的小面板：输入、保存、清除，以及两句实话', () => {
  it('打开后：输入框预填当前值，两句说明都在，且"留空按 N 条"里的 N 来自共享常量', () => {
    mountBar({ tokens: 8192 })
    fireEvent.click(screen.getByText(zh['agent.windowValue'].replace('{n}', '8192')))
    const input = screen.getByLabelText(zh['agent.window']) as HTMLInputElement
    expect(input.value).toBe('8192')
    // 这一句是本批的"说实话"面：这个数不改服务端的 num_ctx
    expect(screen.getByText(zh['agent.windowNotNumCtx'])).toBeTruthy()
    const tip = screen.getByText(
      zh['agent.windowEditorTip']
        .replace('{default}', String(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET))
        .replace('{min}', String(MODEL_WINDOW_MIN_TOKENS))
        .replace('{max}', String(MODEL_WINDOW_MAX_TOKENS))
    )
    expect(tip.textContent).toContain(String(DEFAULT_MESSAGES_WHEN_WINDOW_UNSET))
  })

  it('填一个整数 ⇒ 保存可点，点下去传的是那个数，面板收起', () => {
    const onSet = mountBar({ tokens: null })
    fireEvent.click(screen.getByText(zh['agent.windowUnset']))
    fireEvent.change(screen.getByLabelText(zh['agent.window']), { target: { value: '32000' } })
    fireEvent.click(screen.getByText(zh['common.save']))
    expect(onSet).toHaveBeenCalledTimes(1)
    expect(onSet).toHaveBeenCalledWith(32000)
    expect(screen.queryByLabelText(zh['agent.window'])).toBeNull()
  })

  it('草稿不是整数 ⇒ 保存禁用，但清除照样能点（不把垃圾发去主进程，也不假装"已保存"）', () => {
    const onSet = mountBar({ tokens: null })
    fireEvent.click(screen.getByText(zh['agent.windowUnset']))
    fireEvent.change(screen.getByLabelText(zh['agent.window']), { target: { value: '8192.5' } })
    expect((screen.getByText(zh['common.save']) as HTMLButtonElement).disabled).toBe(true)
    expect(onSet).not.toHaveBeenCalled()
    expect((screen.getByText(zh['agent.windowClear']) as HTMLButtonElement).disabled).toBe(false)
  })

  it('点清除 ⇒ 传 null（回到未设），而不是传 0', () => {
    const onSet = mountBar({ tokens: 8192 })
    fireEvent.click(screen.getByText(zh['agent.windowValue'].replace('{n}', '8192')))
    fireEvent.click(screen.getByText(zh['agent.windowClear']))
    expect(onSet).toHaveBeenCalledWith(null)
    expect(onSet).not.toHaveBeenCalledWith(0)
  })
})

describe('hook 侧：那一读与那一写都各有两条失败面', () => {
  const PROVIDERS = [glm]
  const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
  const CONV = { id: 'c1', assistantId: 'a1', title: 't', modelLabel: null } as unknown as ConversationRecord

  let windows: Record<string, number> | { ok: false; error: string } = {}
  let setReturn: (tokens: number | null) => unknown = () => ({ windows: {} })

  beforeEach(() => {
    windows = {}
    setReturn = () => ({ windows: {} })
    stubPocketai({
      getUiPrefs: () => ({ ok: true, data: {} }),
      setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
      listConversations: () => [CONV],
      listMessages: () => [],
      getLatestRunStats: () => null,
      getSessionStats: () => null,
      getAgentTextProtocol: () => [],
      getModelContextWindows: () => windows,
      getConversation: () => null,
      listChildConversations: () => [],
      setModelContextWindow: (_p: string, _m: string, tokens: number | null) => setReturn(tokens),
      listWorkspaceDir: () => '',
      sendMessage: () => ({ ok: true }),
      abortAgent: () => ({ ok: true }),
      onAgentStep: () => () => {},
      onAgentChunk: () => () => {},
      onAgentDone: () => () => {},
      onAgentError: () => () => {},
      onConversationTitle: () => () => {}
    })
  })

  async function mountHook() {
    const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    act(() => result.current.changeProvider('glm'))
    act(() => result.current.setModel('glm-4.6'))
    await waitFor(() => expect(result.current.model).toBe('glm-4.6'))
    return result
  }

  it('读成功：表里的值就是当前模型的窗口，没设过的模型是 null', async () => {
    windows = { 'glm::glm-4.6': 32000 }
    const result = await mountHook()
    await waitFor(() => expect(result.current.contextWindowTokens).toBe(32000))
    expect(result.current.contextWindowUnread).toBeNull()
  })

  it('读失败：contextWindowUnread 拿到原因，而不是把表咽成空（§221 那一族）', async () => {
    windows = { ok: false, error: '主进程没应答' }
    const result = await mountHook()
    await waitFor(() => expect(result.current.contextWindowUnread).toBe('主进程没应答'))
    expect(result.current.contextWindowTokens).toBeNull()
  })

  it('写成功：以库里回传的表为准（不做本地乐观更新）', async () => {
    setReturn = () => ({ windows: { 'glm::glm-4.6': 128000 } })
    const result = await mountHook()
    await act(async () => {
      result.current.setContextWindow(128000)
    })
    await waitFor(() => expect(result.current.contextWindowTokens).toBe(128000))
  })

  it('写被 IPC 拒（{ok:false}）⇒ toast 说原因，表不变', async () => {
    setReturn = () => ({ ok: false, error: '库写不进去' })
    const result = await mountHook()
    await act(async () => {
      result.current.setContextWindow(8192)
    })
    expect(await screen.findByText('库写不进去')).toBeTruthy()
    expect(result.current.contextWindowTokens).toBeNull()
  })

  it('写被服务层回码拒绝 ⇒ 那句四语文案里的数字来自共享常量（不手抄，§153 同轴）', async () => {
    setReturn = () => ({ windows: {}, rejected: 'MODEL_WINDOW_INVALID_VALUE' })
    const result = await mountHook()
    await act(async () => {
      result.current.setContextWindow(7)
    })
    const line = zh['agent.window.rejected.MODEL_WINDOW_INVALID_VALUE']
      .replace('{min}', String(MODEL_WINDOW_MIN_TOKENS))
      .replace('{max}', String(MODEL_WINDOW_MAX_TOKENS))
    expect(await screen.findByText(line)).toBeTruthy()
  })
})
