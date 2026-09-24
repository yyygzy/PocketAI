// safe-params 助手 defaultParams 安全过滤测试
//
// 覆盖 src/main/agent/safe-params.ts 的 pickSafeParams：
// 仅透传白名单生成参数，丢弃 tools/toolChoice/stream/messages/model/signal 等控制面字段，
// 防止第三方扩展助手注入控制面参数。
//
// 策略：纯函数，无依赖，直接测试。
import { describe, it, expect } from 'vitest'
import { pickSafeParams } from '../src/main/agent/safe-params'

describe('pickSafeParams — 助手 defaultParams 白名单过滤', () => {
  it('null → 空对象', () => {
    expect(pickSafeParams(null)).toEqual({})
  })

  it('空对象 → 空对象', () => {
    expect(pickSafeParams({})).toEqual({})
  })

  it('全白名单参数 → 原样透传', () => {
    const input = {
      temperature: 0.7,
      maxTokens: 2048,
      topP: 0.9,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3
    }
    expect(pickSafeParams(input)).toEqual(input)
  })

  it('控制面字段被丢弃（tools / toolChoice / stream / messages / model / signal）', () => {
    const input = {
      temperature: 0.7,
      tools: [{ type: 'function' }],
      toolChoice: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      model: 'gpt-4',
      signal: {}
    }
    const result = pickSafeParams(input)
    expect(result).toEqual({ temperature: 0.7 })
    expect(result).not.toHaveProperty('tools')
    expect(result).not.toHaveProperty('toolChoice')
    expect(result).not.toHaveProperty('stream')
    expect(result).not.toHaveProperty('messages')
    expect(result).not.toHaveProperty('model')
    expect(result).not.toHaveProperty('signal')
  })

  it('未知字段被丢弃', () => {
    const result = pickSafeParams({ temperature: 0.5, evilField: 'inject', __proto__: {} })
    expect(result).toEqual({ temperature: 0.5 })
    expect(result).not.toHaveProperty('evilField')
    expect(result).not.toHaveProperty('__proto__')
  })

  it('值为 undefined 仍透传（白名单 key 存在即保留）', () => {
    const result = pickSafeParams({ temperature: undefined, maxTokens: 100 })
    expect(result).toHaveProperty('temperature', undefined)
    expect(result).toHaveProperty('maxTokens', 100)
  })

  it('值为 0 / false / null 仍透传', () => {
    const result = pickSafeParams({ temperature: 0, topP: false, maxTokens: null })
    expect(result.temperature).toBe(0)
    expect(result.topP).toBe(false)
    expect(result.maxTokens).toBeNull()
  })
})
