// @vitest-environment node
// 云模型窗口与输出预算的内置默认（v78 第 3 批）
//
// 两条边界必须钉住：
//  1) 用户显式配置优先，内置表只是"没配过"时的默认；
//  2) 本地端点**不套用**内置表——本地 `qwen2.5:7b` 之类的名字也会命中云端模式，
//     但它的窗口由服务端 num_ctx 决定，套上 128k 等于假装它装得下。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_OUTPUT_TOKENS,
  builtinModelWindowTokens,
  resolveAgentOutputTokens
} from '../src/shared/model-window'

describe('builtinModelWindowTokens — 常见线上模型', () => {
  it('DeepSeek / Qwen / OpenAI / Claude / Llama 系列各取保守值', () => {
    expect(builtinModelWindowTokens('deepseek-chat')).toBe(128_000)
    expect(builtinModelWindowTokens('deepseek-reasoner')).toBe(128_000)
    expect(builtinModelWindowTokens('qwen-plus')).toBe(131_072)
    expect(builtinModelWindowTokens('Qwen3-235B-A22B')).toBe(131_072)
    expect(builtinModelWindowTokens('gpt-4o')).toBe(128_000)
    expect(builtinModelWindowTokens('gpt-4.1-mini')).toBe(128_000)
    expect(builtinModelWindowTokens('gpt-3.5-turbo')).toBe(16_385)
    expect(builtinModelWindowTokens('claude-3-7-sonnet')).toBe(200_000)
    expect(builtinModelWindowTokens('llama-3.1-70b')).toBe(128_000)
  })

  it('不认识的模型名 → null（回落到"最近 30 条"口径）', () => {
    expect(builtinModelWindowTokens('my-custom-model')).toBeNull()
    expect(builtinModelWindowTokens('')).toBeNull()
  })
})

describe('resolveAgentOutputTokens — 输出预算', () => {
  it('思考模型给 16k，其它云端给 8k，未知沿用 4k', () => {
    expect(resolveAgentOutputTokens('deepseek-reasoner', 128_000)).toBe(16_384)
    expect(resolveAgentOutputTokens('qwq-32b', 131_072)).toBe(16_384)
    expect(resolveAgentOutputTokens('deepseek-chat', 128_000)).toBe(8_192)
    expect(resolveAgentOutputTokens('qwen-plus', 131_072)).toBe(8_192)
    expect(resolveAgentOutputTokens('some-local-model', null)).toBe(DEFAULT_AGENT_OUTPUT_TOKENS)
  })

  it('本地端点不按模型名放宽（remote=false）', () => {
    expect(resolveAgentOutputTokens('qwen2.5:7b', null, false)).toBe(DEFAULT_AGENT_OUTPUT_TOKENS)
    expect(resolveAgentOutputTokens('deepseek-r1:7b', null, false)).toBe(
      DEFAULT_AGENT_OUTPUT_TOKENS
    )
  })

  it('输出预算被窗口兜住（至少给提示词/历史留 4k）', () => {
    expect(resolveAgentOutputTokens('deepseek-chat', 16_000)).toBe(8_192)
    expect(resolveAgentOutputTokens('deepseek-chat', 6_000)).toBe(1_904)
  })
})
