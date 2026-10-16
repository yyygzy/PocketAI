// 委派步骤的角色标签（V4-Iter-148 / B84）
//
// 为什么标签是**从参数 JSON 现读**而不是事件新字段：`toolCall.function.arguments` 在
// live 事件与历史加载两条路上都已经到位（后者由 `toAgentMessages` 从 DB tool 消息里还原），
// 而 `agent_traces` 一步一行、每行只有一个 `toolName`——同一 step 里两条委派（145 的并行形态）
// 一列装不下 ⇒ 加字段要迁移，迁完了还是装不全。所以这里把"刷新后仍在"钉成可断言的事实。
//
// 另一半是纪律：徽标那个位置只可能出现那三个白名单值，**模型写的原始 role 字符串不会被当标签渲染**
// （参数原文的 `<pre>` 是另一件事，它和普通工具一样整段可见，那是既有行为）。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import type { RenderResult } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { readDelegateRoleForDisplay, DELEGATE_TOOL_NAME } from '../src/shared/delegation-rules'
import { delegateRoleLabel, reduceLiveSteps, toAgentMessages, type LiveStep } from '../src/renderer/src/modules/agent/agent-shared'
import { AgentMessageCard } from '../src/renderer/src/modules/agent/components/AgentMessageCard'
import { messagesReducer } from '../src/renderer/src/modules/agent/hooks/messages-reducer'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { AgentStepEvent, MessageRecord, ToolCall } from '../src/shared/types'

const ROLE_KEYS = ['agent.role.researcher', 'agent.role.writer', 'agent.role.reviewer'] as const

function call(name: string, args: unknown): ToolCall {
  return { id: 'tc-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** 挂真组件；标签"能不能被看见"只能靠渲染出来 */
function mountCallCard(toolCall: ToolCall): RenderResult {
  stubPocketai({})
  return mountWithProviders(<AgentMessageCard m={{ id: 'k1', role: 'tool', text: '', toolCall }} />)
}

const badge = (): Element | null => document.querySelector('[data-delegate-role]')

describe('readDelegateRoleForDisplay：只认白名单，其余一律没标签', () => {
  it('三值各读回自己（不做"宽容纠正"，也不改大小写）', () => {
    for (const role of ['researcher', 'writer', 'reviewer'] as const) {
      expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, JSON.stringify({ role, task: '干活' }))).toBe(role)
    }
  })

  it('不是委派就没有标签：普通工具、名字前缀相同、工具名缺失', () => {
    expect(readDelegateRoleForDisplay('time_now', '{"role":"writer"}')).toBeNull()
    expect(readDelegateRoleForDisplay('delegate_task_v2', '{"role":"writer"}')).toBeNull()
    expect(readDelegateRoleForDisplay(undefined, '{"role":"writer"}')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, undefined)).toBeNull()
  })

  it('JSON 非法 / 不是对象 / role 不是那三值 ⇒ null，且解析永不抛', () => {
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '{role:')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '123')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '"writer"')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, 'null')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '[]')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '{"role":"boss","task":"x"}')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '{"role":123}')).toBeNull()
    expect(readDelegateRoleForDisplay(DELEGATE_TOOL_NAME, '{}')).toBeNull()
  })
})

describe('delegateRoleLabel：三个角色各自取词，四本字典都在', () => {
  it('用 zh 时 writer 拿到的是撰稿而不是检索（防三行写成同一行）', () => {
    const t = (k: string): string => (zh as Record<string, string>)[k] ?? k
    expect(delegateRoleLabel(t, 'researcher')).toBe(zh['agent.role.researcher'])
    expect(delegateRoleLabel(t, 'writer')).toBe(zh['agent.role.writer'])
    expect(delegateRoleLabel(t, 'reviewer')).toBe(zh['agent.role.reviewer'])
  })

  it('每本字典这三条都非空、互不相同（key 集合对等由 i18n-parity 守）', () => {
    for (const [name, dict] of Object.entries({ zh, en, ja, ko })) {
      const values = ROLE_KEYS.map((k) => dict[k as keyof typeof dict])
      for (const v of values) expect(String(v), `${name} 有空文案`).not.toBe('')
      expect(new Set(values).size, `${name} 三条文案雷同`).toBe(3)
    }
  })
})

describe('reduceLiveSteps：chip 流只在这一种步骤带上角色', () => {
  const delegateCall = call(DELEGATE_TOOL_NAME, { role: 'writer', task: '写正文' })

  it('委派的 tool_call 带角色；配对的 tool_result 不带', () => {
    const withCall = reduceLiveSteps([], { stepIndex: 3, type: 'tool_call', toolCall: delegateCall })
    expect(withCall[0]!.role).toBe('writer')
    expect(withCall[0]!.toolName).toBe(DELEGATE_TOOL_NAME)
    const withResult = reduceLiveSteps(withCall, { stepIndex: 3, type: 'tool_result', toolCall: delegateCall })
    expect(withResult[1]!.role, '结果步不该有角色标签（引擎只在持久化时补 arguments）').toBeUndefined()
  })

  it('普通工具 / 角色乱写 / thought 步 ⇒ 只有工具名或什么都没有', () => {
    expect(reduceLiveSteps([], { stepIndex: 1, type: 'tool_call', toolCall: call('time_now', {}) })[0]!.role).toBeUndefined()
    const bogus = reduceLiveSteps([], { stepIndex: 2, type: 'tool_call', toolCall: call(DELEGATE_TOOL_NAME, { role: 'boss', task: 'x' }) })
    expect(bogus[0]!.role).toBeUndefined()
    expect(bogus[0]!.toolName).toBe(DELEGATE_TOOL_NAME)
    const thought: LiveStep[] = reduceLiveSteps([], { stepIndex: 0, type: 'thought', toolCall: delegateCall })
    expect(thought[0]!.role).toBeUndefined()
  })
})

describe('工具卡上的角色标签', () => {
  it('委派卡出现白名单词，data-delegate-role 带的是那个值', () => {
    const r = mountCallCard(call(DELEGATE_TOOL_NAME, { role: 'writer', task: '写正文' }))
    expect(badge()?.textContent).toBe(zh['agent.role.writer'])
    expect(badge()?.getAttribute('data-delegate-role')).toBe('writer')
    // 工具名那行仍是原样（标签是加上去的，不是把 delegate_task 藏了）
    expect(r.baseElement.textContent).toContain(DELEGATE_TOOL_NAME)
    r.unmount()
  })

  it('乱写的 role：不长徽标，标题行只剩工具名那一句', () => {
    // 守的是"别把模型写的字符串当**标签**渲染"，不是"屏幕上看不见它"——
    // 参数原文 `<pre>` 本来就和普通工具一样整段给用户看，那是既有行为。
    const r = mountCallCard(call(DELEGATE_TOOL_NAME, { role: '大管家', task: 'x' }))
    expect(badge()).toBeNull()
    expect(document.querySelector('.font-mono')?.textContent).toBe(zh['agent.callTool'].replace('{name}', DELEGATE_TOOL_NAME))
    r.unmount()
  })

  it('普通工具的卡不带标签（存在性对照：不是所有卡都在长徽标）', () => {
    const r = mountCallCard(call('time_now', {}))
    expect(badge()).toBeNull()
    r.unmount()
  })
})

describe('真链最后一段接线：step 事件 → reducer → 卡片（标签不是只活在纯函数里）', () => {
  it('一条 tool_call 事件经 reducer 变成卡片，卡片画得出角色标签', () => {
    const e: AgentStepEvent = {
      requestId: 'r1',
      conversationId: 'c1',
      stepIndex: 2,
      type: 'tool_call',
      toolCall: call(DELEGATE_TOOL_NAME, { role: 'writer', task: '写正文' })
    }
    const cards = messagesReducer([], { type: 'step', event: e, unknownErrorText: '未知错误' })
    const card = cards.find((c) => c.toolCall)
    expect(card, 'reducer 没把 toolCall 带进卡片 ⇒ 下面那条渲染断言是空的').toBeTruthy()
    stubPocketai({})
    const r = mountWithProviders(<AgentMessageCard m={card!} />)
    expect(badge()?.getAttribute('data-delegate-role')).toBe('writer')
    expect(badge()?.textContent).toBe(zh['agent.role.writer'])
    r.unmount()
  })
})

describe('刷新后标签仍在（走的是历史加载那条路）', () => {
  it('DB 的 tool 消息经 toAgentMessages 还原 ⇒ 卡片读得出角色', () => {
    const dbMsgs = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'tool',
        content: JSON.stringify({
          toolCallId: 'tc-1',
          name: DELEGATE_TOOL_NAME,
          arguments: JSON.stringify({ role: 'reviewer', task: '审一遍' }),
          content: '子代理结论',
          isError: false
        })
      }
    ] as unknown as MessageRecord[]
    const cards = toAgentMessages(dbMsgs)
    const callCard = cards.find((c) => c.toolCall)
    expect(callCard, '历史加载没还原出调用卡 ⇒ 下面那条断言会空过').toBeTruthy()
    const tc = callCard!.toolCall!
    expect(readDelegateRoleForDisplay(tc.function.name, tc.function.arguments)).toBe('reviewer')
    // 真挂一次：还原出来的卡片确实画得出标签（不是只有 JSON 里还在）
    const r = mountCallCard(tc)
    expect(badge()?.getAttribute('data-delegate-role')).toBe('reviewer')
    r.unmount()
  })
})
