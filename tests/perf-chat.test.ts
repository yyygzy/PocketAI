// 聊天/Agent 流式 TTFT 埋点测试（Iter-74）
//
// 覆盖 src/main/steward/perf-probe.ts recordChatStreamPerf：
// - TTFT/total 独立按阈值（5s/30s）判定入缓冲或仅 debug
// - 阈值边界（>= 入缓冲）
// - ttft 缺省只判 total；两值都超 → 两条事件
// - chat/agent label 前缀与 detail（model/step）
// - NaN/Infinity/负数防御性忽略
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import {
  recordChatStreamPerf,
  getRecentPerf,
  clearPerfEvents,
  CHAT_TTFT_SLOW_MS,
  CHAT_TOTAL_SLOW_MS
} from '../src/main/steward/perf-probe'

beforeEach(() => {
  clearPerfEvents()
})

describe('recordChatStreamPerf', () => {
  it('两值均低于阈值：不入缓冲', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: 800, totalMs: 5000, model: 'gpt-x' })
    expect(getRecentPerf()).toHaveLength(0)
  })

  it('TTFT 达到阈值边界（>=5000）：入缓冲，label chat.ttft，detail 带 model', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: CHAT_TTFT_SLOW_MS, totalMs: 1000, model: 'gpt-x' })
    const list = getRecentPerf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'chat.ttft', ms: 5000, detail: 'model=gpt-x' })
  })

  it('TTFT 差 1ms 到阈值：不入缓冲', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: CHAT_TTFT_SLOW_MS - 1, totalMs: 0, model: 'm' })
    expect(getRecentPerf()).toHaveLength(0)
  })

  it('total 达到阈值边界（>=30000）：入缓冲 chat.total', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: 100, totalMs: CHAT_TOTAL_SLOW_MS, model: 'gpt-x' })
    const list = getRecentPerf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'chat.total', ms: 30000 })
  })

  it('两值均超阈值：两条事件，顺序 ttft 在前 total 在后', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: 6000, totalMs: 40000, model: 'gpt-x' })
    const list = getRecentPerf()
    expect(list.map((e) => e.label)).toEqual(['chat.ttft', 'chat.total'])
  })

  it('ttft 缺省（首包前失败场景）：仅判 total', () => {
    recordChatStreamPerf({ kind: 'chat', totalMs: 32000, model: 'gpt-x' })
    const list = getRecentPerf()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'chat.total' })
  })

  it('agent kind：label 前缀 agent.*，detail 追加 step', () => {
    recordChatStreamPerf({ kind: 'agent', ttftMs: 7000, totalMs: 41000, model: 'o1', step: 3 })
    const list = getRecentPerf()
    expect(list.map((e) => e.label)).toEqual(['agent.ttft', 'agent.total'])
    expect(list[0]!.detail).toBe('model=o1 step=3')
    expect(list[1]!.detail).toBe('model=o1 step=3')
  })

  it('agent 无 step 时 detail 不含 step 段', () => {
    recordChatStreamPerf({ kind: 'agent', ttftMs: 7000, totalMs: 100, model: 'o1' })
    expect(getRecentPerf()[0]!.detail).toBe('model=o1')
  })

  it('NaN/Infinity/负数：全部忽略，不入缓冲', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: Number.NaN, totalMs: Number.NaN, model: 'm' })
    recordChatStreamPerf({ kind: 'chat', ttftMs: Number.POSITIVE_INFINITY, totalMs: -1, model: 'm' })
    recordChatStreamPerf({ kind: 'chat', totalMs: -CHAT_TOTAL_SLOW_MS, model: 'm' })
    expect(getRecentPerf()).toHaveLength(0)
  })

  it('0ms 合法（边界，不超阈值不入缓冲，不报错）', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: 0, totalMs: 0, model: 'm' })
    expect(getRecentPerf()).toHaveLength(0)
  })

  it('model 为空时 detail 回退问号', () => {
    recordChatStreamPerf({ kind: 'chat', ttftMs: CHAT_TTFT_SLOW_MS, totalMs: 0, model: '' })
    expect(getRecentPerf()[0]!.detail).toBe('model=?')
  })
})
