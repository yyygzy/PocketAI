// V4-Iter-215：会话与 Agent 面——safeHandle 的失败是 **resolve 的 {ok:false}**，
// 这 11 个点原先把它当"成功后的凭据"用：幻影会话/幻影分组进列表、库里还在的会话从列表消失、
// 标题谎、"已删除 undefined 条"、"已转发"、"已设置提醒"、假 Python 运行时条目。
// 两层证据：① 真挂 useAgentChat 跑行为（含反向对照）；② 11 点逐个切区域的形状闸门。
// AgentPanel 与 McpForm 那两处只有闸门（真挂载要拉起整个聊天面板/表单，成本不值）——如实记在台账。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { HookProviders, stubPocketai } from './helpers/renderer'
import { useAgentChat } from '../src/renderer/src/modules/agent/hooks/useAgentChat'
import type { AssistantRecord, ConversationRecord, ProviderRecord } from '../src/shared/types'

const PROVIDERS = [{ id: 'p1', name: 'P', type: 'openai', enabled: true, models: ['m1'] }] as unknown as ProviderRecord[]
const ASSISTANTS = [{ id: 'a1', name: 'a1', isBuiltin: false, isPinned: false }] as unknown as AssistantRecord[]
const CONV = (id: string): ConversationRecord => ({ id, assistantId: 'a1', title: `旧标题-${id}`, modelLabel: null } as ConversationRecord)

const FAIL = { ok: false, error: '库里没这条' }
const OK = { ok: true }

const baseStubs = (over: Record<string, (...a: any[]) => unknown> = {}): Record<string, any> => ({
  getUiPrefs: () => ({ ok: true, data: {} }),
  setUiPrefs: (patch: Record<string, unknown>) => ({ ok: true, data: patch }),
  listConversations: () => [CONV('c1')],
  listMessages: () => [],
  getLatestRunStats: () => null,
  getSessionStats: () => null,
  getAgentTextProtocol: () => [],
  // §234：模型栏那颗「上下文窗口」挂载要读这张表（桩给空表=没有一台设过）
  getModelContextWindows: () => ({}),
  // §237：挂载时要读这张备用表（桩给空表＝没有一台设过备用）
  getFallbackTargets: () => ({}),
  setFallbackTarget: () => ({ targets: {} }),
  getConversation: () => null,
  listChildConversations: () => [],
  setModelContextWindow: () => ({ windows: {} }),
  sendMessage: () => ({ ok: true }),
  abortAgent: () => OK,
  onAgentStep: () => () => {},
  onAgentChunk: () => () => {},
  onAgentDone: () => () => {},
  onAgentError: () => () => {},
  onConversationTitle: () => () => {},
  ...over
})

const toastTexts = (): string[] => screenText('[role="status"]')
function screenText(sel: string): string[] {
  return [...document.querySelectorAll(sel)].map((e) => e.textContent ?? '')
}

async function mountChat(stubs: Record<string, any>) {
  stubPocketai(baseStubs(stubs))
  const { result } = renderHook(() => useAgentChat(PROVIDERS, ASSISTANTS), { wrapper: HookProviders })
  act(() => result.current.setAssistantId('a1'))
  await waitForConversation(result)
  return result
}

async function waitForConversation(result: { current: { conversationId: string | null } }): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(result.current.conversationId).toBe('c1')
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('① 真挂 useAgentChat：失败不再伪造会话状态', () => {
  it('新建会话失败 ⇒ 列表不增条、当前会话不变、toast 逐字给原因', async () => {
    const result = await mountChat({ createConversation: () => FAIL })
    await act(async () => {
      await result.current.newConversation()
    })
    expect(result.current.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(result.current.conversationId).toBe('c1')
    expect(toastTexts().join('|')).toContain('库里没这条')
  })

  it('删除会话失败 ⇒ 那条**还在列表里**（改前会被本地 filter 掉，而库里没删）', async () => {
    const result = await mountChat({ deleteConversation: () => FAIL })
    await act(async () => {
      await result.current.deleteConversation('c1')
    })
    expect(result.current.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(result.current.conversationId, '当前选中也不该被清').toBe('c1')
    expect(toastTexts().join('|')).toContain('库里没这条')
  })

  it('反向对照：删除成功 ⇒ 列表真的少一条、当前选中清空', async () => {
    const result = await mountChat({ deleteConversation: () => OK })
    await act(async () => {
      await result.current.deleteConversation('c1')
    })
    expect(result.current.conversations).toHaveLength(0)
    expect(result.current.conversationId).toBeNull()
    expect(toastTexts().join('|')).toBe('')
  })

  it('重命名失败 ⇒ 标题仍是旧的那份（不是界面显示新标题而库里没改）', async () => {
    const result = await mountChat({ renameConversation: () => FAIL })
    await act(async () => {
      await result.current.renameConversation('c1', '新标题')
    })
    expect(result.current.conversations[0]!.title).toBe('旧标题-c1')
    expect(toastTexts().join('|')).toContain('库里没这条')
  })

  it('归档失败 ⇒ 不再白跑一趟 reload，并给出提示', async () => {
    let reloads = 0
    const result = await mountChat({
      setConversationArchived: () => FAIL,
      listConversations: () => {
        reloads++
        return [CONV('c1')]
      }
    })
    const before = reloads
    await act(async () => {
      await result.current.setConversationArchivedState('c1', true)
    })
    expect(reloads, '失败后不该再拉一次列表').toBe(before)
    expect(toastTexts().join('|')).toContain('库里没这条')
  })
})

describe('② 形状闸门：11 个点逐个核对「判失败」排在「写成功态」之前', () => {
  const readCode = (rel: string): string =>
    fs
      .readFileSync(path.resolve(__dirname, rel), 'utf-8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n')

  const SITES: Array<[string, string, string]> = [
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', 'createConversation(assistantId)', 'setConversations((prev) => [c'],
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', 'deleteConversation(id)', 'setConversations((prev) => prev.filter'],
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', 'renameConversation(id, title)', 'const patch ='],
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', 'setConversationPinned(id, pinned)', 'await reloadConversations()'],
    ['../src/renderer/src/modules/agent/hooks/useAgentChat.ts', 'setConversationArchived(id, archived)', 'await reloadConversations()'],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'deleteConversations(ids)', "toast.success(t('chat.batchDeleteDone'"],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'createConversationGroup(currentAssistantId, name)', 'setGroups('],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'forwardMessage({', "toast.success(t('chat.forwarded'"],
    ['../src/renderer/src/modules/chat/ChatModule.tsx', 'createNoteFromMessage({', "'pocketai:switch-module'"],
    ['../src/renderer/src/modules/agent/chat/AgentPanel.tsx', 'createReminder({', "'pocketai:reminders-changed'"],
    ['../src/renderer/src/modules/agent/mcp/McpForm.tsx', 'downloadPortablePython()', 'setPyRuntimes(']
  ]

  it('正好 11 个点位（少一处就是闸门在空转）', () => {
    expect(SITES.length).toBe(11)
  })

  for (const [rel, from, until] of SITES) {
    it(`${rel.split('/').pop()} — ${from.slice(0, 30)}… 之后、成功态之前必须判失败`, () => {
      const src = readCode(rel)
      const a = src.indexOf(from)
      expect(a, `锚点丢了：${from}`).toBeGreaterThanOrEqual(0)
      const b = src.indexOf(until, a)
      expect(b, `成功态锚点丢了：${until}`).toBeGreaterThan(a)
      const region = src.slice(a, b)
      // useAgentChat 把这一族的判据抽成了本文件内的 failOp()，所以两种写法都算判了；
      // 抽出去不等于放松——failOp 本体由下面那条用例钉住
      expect(region, `${from} 的失败没判`).toMatch(/hasIpcFailed|isIpcFail|'ok' in |failOp\(/)
      expect(region, `${from} 判了却没守住成功态`).toMatch(/\breturn\b|\belse\b/)
      expect(region, `${from} 判了失败但没有反馈面`).toMatch(/toast\.error|setError|fail\(|onChatSendFailed|failSend|failOp\(/)
    })
  }

  it('failOp 这个助手本体必须真的判失败并弹提示（抽出去不等于放松闸门）', () => {
    const src = readCode('../src/renderer/src/modules/agent/hooks/useAgentChat.ts')
    const start = src.indexOf('const failOp = ')
    expect(start, 'failOp 不见了就直接红，别悄悄把判据抽成永假').toBeGreaterThanOrEqual(0)
    const body = src.slice(start, start + 260)
    expect(body).toContain('hasIpcFailed(r)')
    expect(body).toContain('toast.error(')
    expect(body, '判到失败必须返回 true，否则调用点的 if (failOp(...)) return 形同虚设').toMatch(/return true/)
    expect(body).toMatch(/return false/)
  })

  it('删会话的两个入口现在形状一致（对话页判失败＋Agent 页判失败，不再靠"删后重读"兜差异）', () => {
    const chat = readCode('../src/renderer/src/modules/chat/ChatModule.tsx')
    const agent = readCode('../src/renderer/src/modules/agent/hooks/useAgentChat.ts')
    expect(chat.slice(chat.indexOf('deleteConversations(ids)'), chat.indexOf('batchDeleteDone')).length).toBeGreaterThan(0)
    expect(chat).toContain('if (hasIpcFailed(r))')
    expect(agent).toContain('if (failOp(r)) return')
  })
})
