// P1-3c 收尾：按步重试成功后，旧失败占位在渲染层标「已重试」并折叠置灰。
//
// 守的三件事：
// 1) 判据是**同一锚点下后面还有 assistant 记录**（LLM 步失败会终止整轮 run，同锚点的后续 assistant
//    只能来自新一次 run），不靠文案猜；重试又失败时最后一条没有后续记录，保持正常展示；
// 2) 只改展示：消息条数、正文、上下文构造都不变（cards 数量与 content 原样）；
// 3) 折叠里的原文默认不可见，展开后才出现——「已重试」不是把失败记录删掉。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { toAgentMessages } from '../src/renderer/src/components/agent/agent-shared'
import { AgentMessageCard } from '../src/renderer/src/components/agent/AgentMessageCard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { MessageRecord, MessageStatus } from '../src/shared/types'

const CONV = 'conv-1'
const USER = 'u-1'

function msg(id: string, role: MessageRecord['role'], status: MessageStatus, content: string, parentId: string | null): MessageRecord {
  return {
    id,
    conversationId: CONV,
    role,
    content,
    provider: 'p',
    model: 'm',
    status,
    parentId,
    createdAt: 1
  }
}

/** 一轮 agent 运行：一次失败 + 一次重试成功 */
function failedThenRetried(): MessageRecord[] {
  return [
    msg(USER, 'user', 'done', '跑一下', null),
    msg('a-err', 'assistant', 'error', '_(LLM 调用失败: 连接被重置)_', USER),
    msg('a-ok', 'assistant', 'done', '重试后的回答', USER)
  ]
}

describe('toAgentMessages：已被重试取代的失败占位判定', () => {
  it('同锚点后面有 assistant ⇒ 标已重试；后面的成功回答不标', () => {
    const cards = toAgentMessages(failedThenRetried())
    const err = cards.find((c) => c.id === 'a-err')!
    const ok = cards.find((c) => c.id === 'a-ok')!
    expect(err.supersededByRetry).toBe(true)
    expect(ok.supersededByRetry).toBeFalsy()
  })

  it('历史条数与正文原样：旧占位不删除、不复制、不改写', () => {
    const dbMsgs = failedThenRetried()
    const cards = toAgentMessages(dbMsgs)
    expect(cards).toHaveLength(dbMsgs.length)
    expect(cards.filter((c) => c.role === 'assistant')).toHaveLength(2)
    expect(cards.find((c) => c.id === 'a-err')!.text).toBe('_(LLM 调用失败: 连接被重置)_')
    expect(cards.find((c) => c.id === 'a-ok')!.text).toBe('重试后的回答')
  })

  it('重试又失败：前一条已重试，最后一条保持正常展示', () => {
    const cards = toAgentMessages([
      msg(USER, 'user', 'done', '跑一下', null),
      msg('a-err-1', 'assistant', 'error', '第一次失败', USER),
      msg('a-err-2', 'assistant', 'error', '第二次也失败', USER)
    ])
    expect(cards.find((c) => c.id === 'a-err-1')!.supersededByRetry).toBe(true)
    expect(cards.find((c) => c.id === 'a-err-2')!.supersededByRetry).toBe(false)
  })

  it('没有后续 assistant ⇒ 不折叠（单次失败照常展示）', () => {
    const cards = toAgentMessages([
      msg(USER, 'user', 'done', '跑一下', null),
      msg('a-err', 'assistant', 'error', '只失败了一次', USER)
    ])
    expect(cards.find((c) => c.id === 'a-err')!.supersededByRetry).toBe(false)
  })

  it('不同锚点不互认：别的轮次后面有 assistant 不算被取代', () => {
    const cards = toAgentMessages([
      msg(USER, 'user', 'done', '第一轮', null),
      msg('a-err', 'assistant', 'error', '第一轮失败', USER),
      msg('u-2', 'user', 'done', '第二轮', null),
      msg('a-ok', 'assistant', 'done', '第二轮成功', 'u-2')
    ])
    expect(cards.find((c) => c.id === 'a-err')!.supersededByRetry).toBe(false)
  })

  it('parentId 缺失的老数据不猜（不能证明同轮）', () => {
    const cards = toAgentMessages([
      msg('a-err', 'assistant', 'error', '老数据失败', null),
      msg('a-ok', 'assistant', 'done', '老数据成功', null)
    ])
    expect(cards.find((c) => c.id === 'a-err')!.supersededByRetry).toBe(false)
  })

  it('持久化的 error 占位要如实带 isError（与 live 卡一致）', () => {
    const cards = toAgentMessages(failedThenRetried())
    expect(cards.find((c) => c.id === 'a-err')!.isError).toBe(true)
    expect(cards.find((c) => c.id === 'a-ok')!.isError).toBe(false)
  })
})

describe('AgentMessageCard：已重试的失败占位折叠置灰', () => {
  it('默认只显示「已重试」与提示，原文不出现；展开后原文可见', () => {
    stubPocketai({})
    const card = toAgentMessages(failedThenRetried()).find((c) => c.id === 'a-err')!
    const r = mountWithProviders(<AgentMessageCard m={card} />)
    expect(r.baseElement.querySelector('[data-superseded-retry="1"]')).toBeTruthy()
    expect(r.baseElement.textContent).toContain(zh['agent.supersededRetry'])
    expect(r.baseElement.textContent).toContain(zh['agent.supersededRetryHint'])
    expect(r.baseElement.textContent).not.toContain('_(LLM 调用失败: 连接被重置)_')
    fireEvent.click(r.getByText(zh['agent.supersededRetryShow']))
    expect(r.baseElement.textContent).toContain('_(LLM 调用失败: 连接被重置)_')
    expect(r.getByText(zh['agent.supersededRetryHide'])).toBeTruthy()
    r.unmount()
  })

  it('最后一条失败不走折叠：正文照常可见，没有「已重试」徽标', () => {
    stubPocketai({})
    const cards = toAgentMessages([
      msg(USER, 'user', 'done', '跑一下', null),
      msg('a-err-1', 'assistant', 'error', '第一次失败', USER),
      msg('a-err-2', 'assistant', 'error', '第二次也失败', USER)
    ])
    const last = cards.find((c) => c.id === 'a-err-2')!
    const r = mountWithProviders(<AgentMessageCard m={last} />)
    expect(r.baseElement.querySelector('[data-superseded-retry="1"]')).toBeNull()
    expect(r.baseElement.textContent).toContain('第二次也失败')
    expect(r.baseElement.textContent).not.toContain(zh['agent.supersededRetry'])
    r.unmount()
  })
})
