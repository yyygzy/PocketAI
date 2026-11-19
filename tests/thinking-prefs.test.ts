// @vitest-environment node
// 模型级「关闭思考模式」开关（v78 第 4 批产品化项）
//
// 这个开关的正确性全在三件事上：
//  1) 键必须是 `providerId::model`（否则引擎永远 miss，用户点了等于没点）；
//  2) 只存"显式关闭"，取消开关＝从清单移除＝回到服务端默认；
//  3) `thinkingParamFor` 未关闭时返回空对象——多余字段会让不认识的端点 400。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k)
    },
    writes: [] as string[]
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => mocks.appConfigRepo.get(k),
    set: (k: string, v: string) => {
      mocks.writes.push(k)
      mocks.appConfigRepo.set(k, v)
    }
  }
}))

import {
  MAX_THINKING_DISABLED_MODELS,
  isThinkingDisabled,
  listThinkingDisabledModels,
  normalizeThinkingDisabledModels,
  setThinkingDisabled,
  thinkingDisabledKey,
  thinkingParamFor
} from '../src/main/agent/thinking-prefs'
import { isThinkingCapableModel } from '../src/shared/thinking-models'

const K = 'agent.thinking_disabled_models'

beforeEach(() => {
  mocks.store.clear()
  mocks.writes.length = 0
})

describe('thinkingDisabledKey / normalizeThinkingDisabledModels', () => {
  it('键形如 providerId::model（与窗口/文本协议同形，用户可对照）', () => {
    expect(thinkingDisabledKey('p1', 'qwen3-235b')).toBe('p1::qwen3-235b')
  })

  it('丢掉脏值：非字符串、缺 ::、空片段、超长', () => {
    expect(
      normalizeThinkingDisabledModels([
        1,
        'no-separator',
        '::m',
        'p::',
        'ok::model',
        `${'p'.repeat(129)}::model`
      ])
    ).toEqual(['ok::model'])
  })

  it('重复项去重、条数封顶', () => {
    expect(normalizeThinkingDisabledModels(['p::m', 'p::m'])).toEqual(['p::m'])
    const many = Array.from({ length: MAX_THINKING_DISABLED_MODELS + 5 }, (_, i) => `p::m${i}`)
    expect(normalizeThinkingDisabledModels(many)).toHaveLength(MAX_THINKING_DISABLED_MODELS)
  })

  it('非数组/脏 JSON 一律当空清单', () => {
    expect(normalizeThinkingDisabledModels(null)).toEqual([])
  })
})

describe('listThinkingDisabledModels', () => {
  it('未配置 → 空清单；脏 JSON → 空清单（不抛）', () => {
    expect(listThinkingDisabledModels()).toEqual([])
    mocks.store.set(K, '{not json')
    expect(listThinkingDisabledModels()).toEqual([])
  })
})

describe('isThinkingDisabled / setThinkingDisabled', () => {
  it('写开/关并按 provider+model 精确命中', () => {
    expect(isThinkingDisabled('p1', 'qwen3')).toBe(false)
    const afterOn = setThinkingDisabled('p1', 'qwen3', true)
    expect(afterOn).toEqual(['p1::qwen3'])
    expect(isThinkingDisabled('p1', 'qwen3')).toBe(true)
    // 另一台模型不受影响（模型级开关，不是 provider 级）
    expect(isThinkingDisabled('p1', 'qwen3-coder')).toBe(false)

    expect(setThinkingDisabled('p1', 'qwen3', false)).toEqual([])
    expect(isThinkingDisabled('p1', 'qwen3')).toBe(false)
  })

  it('非法输入直接拒绝（返回当前清单、不写库）', () => {
    expect(setThinkingDisabled('', 'm', true)).toEqual([])
    expect(setThinkingDisabled('p', '', true)).toEqual([])
    expect(setThinkingDisabled('p::x', 'm', true)).toEqual([])
    expect(mocks.writes).toHaveLength(0)
  })

  it('状态没变化时不写库（避免无意义的 KV 抖动）', () => {
    setThinkingDisabled('p1', 'm', true)
    mocks.writes.length = 0
    expect(setThinkingDisabled('p1', 'm', true)).toEqual(['p1::m'])
    expect(mocks.writes).toHaveLength(0)
  })
})

describe('thinkingParamFor — 接进入已打通的 enable_thinking 管线', () => {
  it('未关闭 → 空对象（绝不带 enable_thinking 字段）', () => {
    expect(thinkingParamFor('p1', 'qwen3')).toEqual({})
    expect(thinkingParamFor('', '')).toEqual({})
  })

  it('已关闭 → { enableThinking: false }', () => {
    setThinkingDisabled('p1', 'qwen3', true)
    expect(thinkingParamFor('p1', 'qwen3')).toEqual({ enableThinking: false })
    expect(thinkingParamFor('p1', 'other')).toEqual({})
  })

  it('模型本身不认 enable_thinking（GPT/Gemini/Claude）→ 即使点了关闭也不下发（否则端点 400）', () => {
    for (const m of ['gpt-4o', 'gemini-2.5-pro', 'claude-3-7-sonnet', 'deepseek-chat']) {
      setThinkingDisabled('p1', m, true)
      expect(thinkingParamFor('p1', m)).toEqual({})
    }
  })
})

describe('isThinkingCapableModel — 能力域', () => {
  it('Qwen3 / QwQ / DashScope 的 plus·max 系列命中', () => {
    for (const m of ['qwen3-8b', 'Qwen3-235B-A22B', 'qwq-32b', 'qwen-plus', 'qwen-max']) {
      expect(isThinkingCapableModel(m)).toBe(true)
    }
  })

  it('Qwen2.5 及更早、OpenAI 系不命中（它们没有该参数）', () => {
    for (const m of ['qwen2.5:7b', 'gpt-4o', 'o3-mini', 'claude-3-7-sonnet', 'deepseek-chat', '']) {
      expect(isThinkingCapableModel(m)).toBe(false)
    }
  })
})
