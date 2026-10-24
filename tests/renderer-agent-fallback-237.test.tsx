// @vitest-environment jsdom
// V4-Iter-237 的界面那一半：模型栏那颗「备用」徽标的四张脸，与那句"这一轮带不下更多历史"。
//
// 判据取向与本仓一贯：每种"没有"都要分开说——没设过／读不到／设了但那台已经不在这个实例里，
// 三张脸若长成一张，用户就会把"兜底坏了"读成"我没设兜底"（§222／§226 那一族的同一条轴）。
// 每条负向判据都配一条正向对照，免得坏成恒空的分支一路绿灯。
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type { AssistantRecord } from '../src/shared/types'
import { HookProviders, mountWithProviders, pocketaiCalls, stubPocketai } from './helpers/renderer'
import { AgentPanel } from '../src/renderer/src/modules/agent/chat/AgentPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import { fallbackTargetKey } from '../src/shared/fallback-target'
import type { ConversationRecord, ProviderRecord } from '../src/shared/types'

const glm = {
  id: 'glm',
  name: '智谱 GLM',
  enabled: true,
  models: ['glm-4.6', 'glm-4.5']
} as unknown as ProviderRecord

const ollama = {
  id: 'ollama',
  name: '本地 Ollama',
  enabled: true,
  models: ['qwen3:1.7b']
} as unknown as ProviderRecord

const CONVERSATION = {
  id: 'c1',
  assistantId: 'a1',
  title: '会话一',
  // 带 agent: 前缀的形状会被 applyLastModelOf 解析成 provider＋模型：挂载后不用手点就能进"已选模型"态
  modelLabel: 'agent:glm:glm-4.6',
  parentConversationId: null,
  roleKey: null
} as unknown as ConversationRecord

/** 夹具：备用表、读是否失败、设的回应，以及服务商列表（换列表**不**改常量对象，见下面第 3 条用例的教训） */
let table: Record<string, { providerId: string; model: string }>
let readFail: { ok: false; error: string } | null
let setReply: { targets: Record<string, { providerId: string; model: string }>; rejected?: string }
let providerList: ProviderRecord[]
const h = { done: [] as Array<(e: any) => void> }
function subDone(bucket: Array<(e: any) => void>) {
  return (...args: unknown[]) => {
    const fn = args[0] as (e: any) => void
    bucket.push(fn)
    return () => {
      const k = bucket.indexOf(fn)
      if (k >= 0) bucket.splice(k, 1)
    }
  }
}


function stubBase(): Record<string, (...args: any[]) => unknown> {
  return {
    listProviders: () => providerList,
    listAssistants: () => [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }],
    getUiPrefs: () => ({ ok: true, data: { agentAssistantId: 'a1', agentConversationId: 'c1' } }),
    setUiPrefs: (p: Record<string, unknown>) => ({ ok: true, data: p }),
    listConversations: (_a: string, _isAgent: boolean, archivedOnly?: boolean) =>
      archivedOnly ? [] : [CONVERSATION],
    listMessages: () => [],
    getLatestRunStats: () => null,
    getSessionStats: () => null,
    getLatestRunTraces: () => [],
    getAgentTextProtocol: () => [],
    getModelContextWindows: () => ({}),
    // §237：备用表挂载读一次；设/清回传最新表（界面不做乐观更新）
    getFallbackTargets: () => (readFail ?? table),
    setFallbackTarget: (_p: string, _m: string, t: { providerId: string; model: string } | null) => ({
      targets: t ? { ...table, [fallbackTargetKey(_p, _m)]: t } : (() => {
        const next: Record<string, { providerId: string; model: string }> = {}
        for (const [k, v] of Object.entries(table)) if (k !== fallbackTargetKey(_p, _m)) next[k] = v
        return next
      })(),
      ...(setReply.rejected ? { rejected: setReply.rejected } : {})
    }),
    getConversation: () => null,
    listChildConversations: () => [],
    getAgentWorkspaceDir: () => '',
    getShellConfig: () => ({}),
    getWebSearchConfig: () => ({}),
    getCalendarConfig: () => ({}),
    fetchModels: () => ({ ok: true }),
    sendMessage: () => ({ ok: true }),
    abortAgent: () => ({ ok: true }),
    interjectAgent: () => ({ ok: true }),
    // DONE 事件由夹具决定带不带 historyTight：订阅侧把 handler 记下来，用例自己喂
    onAgentStep: () => () => {},
    onAgentChunk: () => () => {},
    onAgentDone: subDone(h.done),
    onAgentError: () => () => {},
    onConversationTitle: () => () => {}
  }
}

beforeEach(() => {
  table = {}
  readFail = null
  setReply = { targets: {} }
  providerList = [glm, ollama]
  h.done.length = 0
  stubPocketai(stubBase())
})

// §298：徽标要等整条挂载链（getUiPrefs→listConversations→applyLastModelOf 设 providerId/model）
// 跑完才渲染。findBy/裸 waitFor 走 testing-library 自己的 asyncUtilTimeout（默认 1000ms），
// 与 vitest testTimeout 是两条独立预算；满载 240 isolate worker 抢机器时这条链墙钟能 >1s
// ⇒ §295 撞出"找不到徽标"的红（§297 定性）。统一给 8s／50ms 预算（与 §293 同一味药）。
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

const badge = async (): Promise<HTMLElement> => (await screen.findByTestId('agent-fallback-badge', {}, MOUNT_BUDGET)) as HTMLElement

describe('备用徽标的四张脸', () => {
  it('没设过：说"备用未设"，而不是给一个看起来像读数的空位', async () => {
    mountWithProviders(<AgentPanel />)
    expect((await badge()).textContent).toBe(zh['agent.fallbackUnset'])
  })

  it('设过：徽标同时念出服务商名与模型名（不是 id），点开编辑器草稿已是当前那一对', async () => {
    table = { [fallbackTargetKey('glm', 'glm-4.6')]: { providerId: 'ollama', model: 'qwen3:1.7b' } }
    mountWithProviders(<AgentPanel />)
    const text = (await badge()).textContent ?? ''
    expect(text).toContain('本地 Ollama')
    expect(text).toContain('qwen3:1.7b')
    // 反向对照：这一张脸不能是"未设"
    expect(text).not.toBe(zh['agent.fallbackUnset'])
    fireEvent.click(screen.getByTestId('agent-fallback-badge'))
    const editor = await screen.findByTestId('agent-fallback-editor', {}, MOUNT_BUDGET)
    const selects = editor.querySelectorAll('select')
    expect((selects[0] as HTMLSelectElement).value).toBe('ollama')
    expect((selects[1] as HTMLSelectElement).value).toBe('qwen3:1.7b')
  })

  it('设了但那台被停用 ⇒ 说"已不在这个实例里"，不退回去演"未设"', async () => {
    table = { [fallbackTargetKey('glm', 'glm-4.6')]: { providerId: 'ollama', model: 'qwen3:1.7b' } }
    providerList = [glm, { ...ollama, enabled: false } as unknown as ProviderRecord]
    mountWithProviders(<AgentPanel />)
    const text = (await badge()).textContent ?? ''
    expect(text).toContain(zh['agent.fallbackMissing'].replace('{model}', 'qwen3:1.7b'))
  })

  it('读不到：那句说的是"读不到"并带原因，而不是"备用未设"', async () => {
    readFail = { ok: false, error: '主进程没应答' }
    mountWithProviders(<AgentPanel />)
    const el = await badge()
    expect(el.textContent).toBe(zh['agent.fallbackReadFail'])
    expect(el.getAttribute('title')).toContain('主进程没应答')
  })
})

describe('设与清：实参照写、拒绝照说', () => {
  it('挑一对再保存 ⇒ 发给主进程的是（当前 provider, 当前模型, 那一对），界面不自作主张先改徽标', async () => {
    mountWithProviders(<AgentPanel />)
    fireEvent.click(await badge())
    const editor = await screen.findByTestId('agent-fallback-editor', {}, MOUNT_BUDGET)
    const selects = editor.querySelectorAll('select')
    fireEvent.change(selects[0]!, { target: { value: 'ollama' } })
    fireEvent.change(selects[1]!, { target: { value: 'qwen3:1.7b' } })
    fireEvent.click(screen.getByTestId('agent-fallback-save'))
    await waitFor(() =>
      expect(
        pocketaiCalls().filter((c) => c.fn === 'setFallbackTarget').at(-1)?.args
      ).toEqual(['glm', 'glm-4.6', { providerId: 'ollama', model: 'qwen3:1.7b' }])
    , MOUNT_BUDGET
    )
  })

  it('清除那一发带的是 null（不是空对象，也不是漏参数）', async () => {
    table = { [fallbackTargetKey('glm', 'glm-4.6')]: { providerId: 'ollama', model: 'qwen3:1.7b' } }
    mountWithProviders(<AgentPanel />)
    fireEvent.click(await badge())
    fireEvent.click(await screen.findByTestId('agent-fallback-clear', {}, MOUNT_BUDGET))
    await waitFor(() =>
      expect(pocketaiCalls().filter((c) => c.fn === 'setFallbackTarget').at(-1)?.args).toEqual([
        'glm',
        'glm-4.6',
        null
      ])
    , MOUNT_BUDGET
    )
    await waitFor(() => expect(screen.getByTestId('agent-fallback-badge').textContent).toBe(zh['agent.fallbackUnset']), MOUNT_BUDGET)
  })

  it('两个都没选 ⇒ 保存是灰的（不发一次"清除"，也不发一条空备用）', async () => {
    mountWithProviders(<AgentPanel />)
    fireEvent.click(await badge())
    const save = (await screen.findByTestId('agent-fallback-save', {}, MOUNT_BUDGET)) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(pocketaiCalls().some((c) => c.fn === 'setFallbackTarget')).toBe(false)
  })

  it('候选里没有当前这台自己：它是唯一 provider 且只有当前这一个模型时，下拉里只剩占位', async () => {
    // 换列表而不是改常量对象：上一条用例红在半路会把 `models` 留成一模型的残局，
    // 让下一条（拒绝那一条）挑不到 glm-4.5 ⇒ 保存键灰着、toast 等不到——串味道的用例不是好用例
    providerList = [
      { ...glm, models: ['glm-4.6'] } as unknown as ProviderRecord,
      { ...ollama, enabled: false } as unknown as ProviderRecord
    ]
    mountWithProviders(<AgentPanel />)
    fireEvent.click(await badge())
    const editor = await screen.findByTestId('agent-fallback-editor', {}, MOUNT_BUDGET)
    const providerOptions = editor.querySelectorAll('select')[0]!.querySelectorAll('option')
    // 只有那条占位「选择 Provider…」——把自己列进候选等于给用户一个"点了没换"的按钮
    expect(providerOptions).toHaveLength(1)
  })

  it('服务层拒绝（指向自己这类）⇒ 说出那句四语话术，徽标不偷偷变成"设好了"', async () => {
    setReply = { targets: {}, rejected: 'FALLBACK_IS_SELF' }
    mountWithProviders(<AgentPanel />)
    fireEvent.click(await badge())
    const editor = await screen.findByTestId('agent-fallback-editor', {}, MOUNT_BUDGET)
    const selects = editor.querySelectorAll('select')
    fireEvent.change(selects[0]!, { target: { value: 'glm' } })
    fireEvent.change(selects[1]!, { target: { value: 'glm-4.5' } })
    fireEvent.click(screen.getByTestId('agent-fallback-save'))
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('[role=status]'))
          .map((n) => n.textContent ?? '')
          .join('\n')
      ).toContain(zh['agent.fallback.rejected.FALLBACK_IS_SELF'])
    , MOUNT_BUDGET
    )
    expect(screen.getByTestId('agent-fallback-badge').textContent).toBe(zh['agent.fallbackUnset'])
  })
})

describe('溢出提示那句：只在引擎真算得出来时才出现', () => {
  /** 起一轮真运行：发送 → 进 running，并给出这一发的 requestId（DONE 要按它归属） */
  async function startRun(): Promise<{ requestId: () => string }> {
    mountWithProviders(<AgentPanel />)
    await waitFor(() => expect(screen.getByText(zh['common.send'])).toBeTruthy(), MOUNT_BUDGET)
    const input = screen.getByTitle(zh['agent.composerTitle']) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '跑一件事' } })
    await waitFor(() =>
      expect((screen.getByText(zh['common.send']) as HTMLButtonElement).disabled).toBe(false)
    , MOUNT_BUDGET
    )
    fireEvent.click(screen.getByText(zh['common.send']))
    await waitFor(() => expect(screen.getByText(zh['common.stop'])).toBeTruthy(), MOUNT_BUDGET)
    return {
      requestId: () =>
        (pocketaiCalls().filter((c) => c.fn === 'sendMessage').at(-1)!.args[0] as { requestId: string })
          .requestId
    }
  }

  const feedDone = (extra: Record<string, unknown>, requestId: string): void => {
    expect(h.done.length, '没订阅上 DONE 就没法喂事件').toBeGreaterThan(0)
    const e = {
      requestId,
      conversationId: 'c1',
      finalMessageId: 'x',
      fullContent: '',
      stepCount: 2,
      ...extra
    }
    act(() => {
      for (const fn of h.done) fn(e)
    })
  }

  it('DONE 带 historyTight ⇒ 那句上屏；点关闭就没了', async () => {
    const { requestId } = await startRun()
    feedDone({ historyTight: true }, requestId())
    const notice = await screen.findByTestId('history-tight-notice', {}, MOUNT_BUDGET)
    expect(notice.textContent).toContain(zh['agent.historyTightHint'])
    fireEvent.click(screen.getByTestId('history-tight-close'))
    await waitFor(() => expect(screen.queryByTestId('history-tight-notice')).toBeNull(), MOUNT_BUDGET)
  })

  it('反向对照：正常一轮不带这个标记 ⇒ 不出现那句（量不出来就不猜给用户）', async () => {
    const { requestId } = await startRun()
    feedDone({}, requestId())
    await waitFor(() => expect(screen.queryByText(zh['common.stop'])).toBeNull(), MOUNT_BUDGET)
    expect(screen.queryByTestId('history-tight-notice')).toBeNull()
  })

  it('上一轮那句不许跟着起新一轮', async () => {
    const { requestId } = await startRun()
    feedDone({ historyTight: true }, requestId())
    await screen.findByTestId('history-tight-notice', {}, MOUNT_BUDGET)
    const input = screen.getByTitle(zh['agent.composerTitle']) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '第二问' } })
    fireEvent.click(screen.getByText(zh['common.send']))
    await waitFor(() => expect(screen.queryByTestId('history-tight-notice')).toBeNull(), MOUNT_BUDGET)
  })
})

describe('historyTight 是「那一轮」的事实，不是会话的属性（hook 层，变异 U7 打的就是这一条）', () => {
  it('切到别的会话 ⇒ 那句归零（回来也不该还亮着）', async () => {
    const { result } = renderHook(
      () => useAgentChat([glm], [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]),
      { wrapper: HookProviders }
    )
    act(() => result.current.setAssistantId('a1'))
    await waitFor(() => expect(result.current.conversationId).toBe('c1'), MOUNT_BUDGET)
    act(() => result.current.changeProvider('glm'))
    act(() => result.current.setModel('glm-4.6'))
    await act(async () => {
      void result.current.send('跑一件事', [])
    })
    const requestId = (
      pocketaiCalls().filter((c) => c.fn === 'sendMessage').at(-1)!.args[0] as { requestId: string }
    ).requestId
    expect(h.done.length).toBeGreaterThan(0)
    act(() => {
      for (const fn of h.done) {
        fn({
          requestId,
          conversationId: 'c1',
          finalMessageId: 'x',
          fullContent: '',
          stepCount: 2,
          historyTight: true
        })
      }
    })
    expect(result.current.historyTight, '那句该亮着（正向对照，否则下面那条断言是恒真的）').toBe(true)
    act(() => result.current.selectConversation('c2'))
    expect(result.current.historyTight).toBe(false)
  })
})
