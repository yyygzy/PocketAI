// Agent 引擎纯函数测试
import { describe, it, expect } from 'vitest'
import { pickSafeParams } from '../src/main/agent/safe-params'

describe('pickSafeParams 参数白名单', () => {
  it('null 返回空对象', () => {
    expect(pickSafeParams(null)).toEqual({})
  })

  it('空对象返回空对象', () => {
    expect(pickSafeParams({})).toEqual({})
  })

  it('白名单内的 key 保留原值', () => {
    const params = {
      temperature: 0.7,
      maxTokens: 2048,
      topP: 0.9,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3
    }
    expect(pickSafeParams(params)).toEqual(params)
  })

  it('白名单外的控制面字段被过滤（防注入）', () => {
    const params = {
      temperature: 0.7,
      tools: [{ name: 'shell' }],
      toolChoice: 'auto',
      stream: true,
      messages: [{ role: 'user' }],
      model: 'gpt-4',
      signal: {}
    }
    const result = pickSafeParams(params)
    expect(result).toEqual({ temperature: 0.7 })
    expect(result).not.toHaveProperty('tools')
    expect(result).not.toHaveProperty('toolChoice')
    expect(result).not.toHaveProperty('stream')
    expect(result).not.toHaveProperty('messages')
    expect(result).not.toHaveProperty('model')
    expect(result).not.toHaveProperty('signal')
  })

  it('混合白名单内外字段，只保留白名单内的', () => {
    const params = {
      temperature: 0.7,
      maxTokens: 1024,
      maliciousField: 'injected',
      tools: []
    }
    expect(pickSafeParams(params)).toEqual({ temperature: 0.7, maxTokens: 1024 })
  })

  it('白名单内 key 值为 undefined 时也保留（透传语义）', () => {
    const params = { temperature: undefined, maxTokens: 2048 }
    const result = pickSafeParams(params)
    expect(Object.keys(result)).toContain('temperature')
    expect(result.temperature).toBeUndefined()
    expect(result.maxTokens).toBe(2048)
  })
})
