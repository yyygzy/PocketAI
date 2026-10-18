// Agent 的选中服务商/模型必须跟着"当前服务商列表"走（V4-Iter-116）
//
// 背景：服务商列表现在会在切回 Agent 模块时重拉（在设置里删了/停用了服务商、
// 或点「拉取模型」后清单变了都会让它变），而 `providerId/model` 是 hook 本地 state。
// 不校验的话会出现两种难看结果：① 模型栏因找不到对应 provider 而整块消失，
// 但 canSend 仍为真 → 请求发给一个不存在的服务商；② 模型被从缓存里删掉后下拉显示空白，
// 发送照旧带着那个不存在的模型。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { stubPocketai, HookProviders } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const withModels = (models: string[]): ProviderRecord[] =>
  [{ id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models }] as unknown as ProviderRecord[]

const assistant = (id: string): AssistantRecord =>
  ({ id, name: id, isBuiltin: false, isPinned: false }) as unknown as AssistantRecord

const conv = (id: string, modelLabel: string | null): ConversationRecord =>
  ({
    id,
    assistantId: 'a1',
    title: `会话 ${id}`,
    modelLabel,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    titleDefault: false
  })

let providers = withModels(['gpt-mini', 'gpt-max'])

function mount() {
  stubPocketai({
    getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
    setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
    getAgentTextProtocol: () => [],
    setAgentTextProtocol: () => [],
    // 列表头部是「最近一条」c2，存档指向 c1：切回来若误重跑列表 effect 就会跳到 c2
    listConversations: (_a: string, _agent: boolean, isArchived: boolean) =>
      isArchived ? [] : [conv('c2', 'p1:gpt-max'), conv('c1', 'p1:gpt-mini')],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: () => () => {},
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  })
  return renderHook(() => useAgentChat(providers, [assistant('a1')]), {
    wrapper: HookProviders
  })
}

beforeEach(() => {
  localStorage.clear()
  providers = withModels(['gpt-mini', 'gpt-max'])
})

describe('服务商列表变化时的选中项校验', () => {
  it('基线：恢复来的会话把 provider+模型回填，canSend 成立', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.model).toBe('gpt-mini'))
    expect(result.current.providerId).toBe('p1')
    expect(result.current.canSend).toBe(true)
  })

  it('服务商从列表里消失（被删/停用）→ provider 与模型一起清空，canSend 变 false', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.model).toBe('gpt-mini'))
    providers = []
    act(() => rerender())
    await waitFor(() => expect(result.current.providerId).toBe(''))
    expect(result.current.model).toBe('')
    expect(result.current.canSend).toBe(false)
  })

  it('服务商还在、但当前模型被移出缓存 → 只清模型、保留服务商（模型栏应回到「选择模型」而不是消失）', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.model).toBe('gpt-mini'))
    providers = withModels(['gpt-max'])
    act(() => rerender())
    await waitFor(() => expect(result.current.model).toBe(''))
    expect(result.current.providerId).toBe('p1')
    expect(result.current.canSend).toBe(false)
  })

  // 这条钉的是我自己上一批埋的坑：applyLastModelOf 曾进过会话列表 effect 的依赖，
  // providers 一换引用（切回模块重拉列表）就重跑那个 effect，把会话跳回「最近一条」。
  it('服务商列表刷新不得改变当前会话（存档的 c1 不能被跳回最近一条 c2）', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.conversationId).toBe('c1'))
    providers = withModels(['gpt-mini', 'gpt-max', 'gpt-new'])
    act(() => rerender())
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.conversationId).toBe('c1')
    expect(result.current.model).toBe('gpt-mini')
  })

  it('反向对照：列表刷新但选中项仍然有效 → 一个都不动（不能把用户手选的模型打回去）', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.model).toBe('gpt-mini'))
    providers = withModels(['gpt-mini', 'gpt-max', 'gpt-new'])
    act(() => rerender())
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.providerId).toBe('p1')
    expect(result.current.model).toBe('gpt-mini')
    expect(result.current.canSend).toBe(true)
  })
})
