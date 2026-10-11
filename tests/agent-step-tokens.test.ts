// Agent 分步明细的 token 文案（V4-Iter-98）
// 钉的是"看不出贵在哪"这条：拆分优先、旧行退回合计、半残不许出现 undefined、
// 工具步（没有任何 usage）不占位。
// 文案直接取真字典 zh，插值规则与 i18n 一致（{in}/{out} 占位）。
import { describe, it, expect } from 'vitest'
import { zh } from '../src/renderer/src/i18n/zh'
import { formatStepTokens } from '../src/renderer/src/utils/agent-step-tokens'
import type { AgentTraceRecord } from '../src/shared/types'

const t = (key: string, vars?: Record<string, string | number>): string =>
  zh[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''))

const trace = (patch: Partial<AgentTraceRecord>): AgentTraceRecord => ({
  id: 't1',
  requestId: 'r1',
  conversationId: 'c1',
  stepIndex: 0,
  stepType: 'llm',
  status: 'success',
  createdAt: 1,
  ...patch
})

describe('formatStepTokens', () => {
  it('输入/输出齐全 → 走 agent.stepTokens 模板，数字带千分位', () => {
    const label = formatStepTokens(
      trace({ tokenUsage: 5507, promptTokens: 5301, completionTokens: 206 }),
      t
    )
    expect(label).toBe(t('agent.stepTokens', { in: '5,301', out: '206' }))
    expect(label).toContain('5,301')
    expect(label).toContain('206')
  })

  it('v46 之前的旧行（只有合计）→ 退回「N tokens」', () => {
    expect(formatStepTokens(trace({ tokenUsage: 5507 }), t)).toBe('5,507 tokens')
  })

  it('只有拆分的一半（端点少报字段）→ 不许渲染出 undefined，退回合计', () => {
    expect(formatStepTokens(trace({ tokenUsage: 300, promptTokens: 280 }), t)).toBe('300 tokens')
    expect(formatStepTokens(trace({ tokenUsage: 300, completionTokens: 20 }), t)).toBe('300 tokens')
    // 连合计都没有时不许出现 "undefined tokens"
    expect(formatStepTokens(trace({ promptTokens: 280 }), t)).toBeNull()
  })

  it('工具步（不发请求，无任何 usage）→ null，不占位', () => {
    expect(formatStepTokens(trace({ stepType: 'tools', toolName: 'time_now' }), t)).toBeNull()
  })
})
