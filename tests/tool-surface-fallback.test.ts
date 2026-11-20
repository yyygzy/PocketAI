// 工具面兜底判定（v79 第二批）
//
// 这层是纯函数，引擎只负责执行：三种信号（空集 / 模型声称无工具 / 已经用过）必须
// 各自独立可测，否则"只重试一次"和"不越过授权"两件事都只能靠读代码相信。
import { describe, expect, it } from 'vitest'
import { claimsNoTools, shouldFallbackOnClaim, shouldFallbackOnEmptySurface } from '../src/shared/tool-surface-fallback'

describe('claimsNoTools — 严格措辞，宁可漏判不误判', () => {
  it('中文声称命中', () => {
    for (const t of [
      '当前没有可用的工具。',
      '抱歉，我没有任何工具可用。',
      '我无法使用工具来查询实时数据。',
      '工具不可用，我无法获取',
      '本轮不能调用工具'
    ]) {
      expect(claimsNoTools(t)).toBe(true)
    }
  })

  it('英文声称命中', () => {
    for (const t of ['No tools are available.', 'Tools are not available in this session.', "I don't have access to any tools.", 'I cannot call tools.']) {
      expect(claimsNoTools(t)).toBe(true)
    }
  })

  it('正常回答/只提"工具"二字不命中', () => {
    for (const t of [
      '我可以用工具查询天气，请告诉我城市。',
      '这个工具需要联网，我来调用。',
      'The tool returns JSON.',
      '',
      '工具调用完成，结果如下。'
    ]) {
      expect(claimsNoTools(t)).toBe(false)
    }
  })
})

describe('shouldFallbackOnEmptySurface', () => {
  it('收窄为空 + 授权非空 + 允许兜底 → 触发', () => {
    expect(
      shouldFallbackOnEmptySurface({ fallbackEnabled: true, narrowedCount: 0, authorizedCount: 5, alreadyUsed: false })
    ).toBe(true)
  })

  it('授权本身就是空 → 不触发（不能越过授权）', () => {
    expect(
      shouldFallbackOnEmptySurface({ fallbackEnabled: true, narrowedCount: 0, authorizedCount: 0, alreadyUsed: false })
    ).toBe(false)
  })

  it('full 模式 / 已用过 → 不触发', () => {
    expect(
      shouldFallbackOnEmptySurface({ fallbackEnabled: false, narrowedCount: 0, authorizedCount: 5, alreadyUsed: false })
    ).toBe(false)
    expect(
      shouldFallbackOnEmptySurface({ fallbackEnabled: true, narrowedCount: 0, authorizedCount: 5, alreadyUsed: true })
    ).toBe(false)
  })
})

describe('shouldFallbackOnClaim — 整轮只一次', () => {
  const base = {
    fallbackEnabled: true,
    alreadyUsed: false,
    toolCallsCount: 0,
    narrowedCount: 3,
    fullCount: 27,
    text: '当前没有可用的工具。'
  }

  it('条件齐备 → 触发', () => {
    expect(shouldFallbackOnClaim(base)).toBe(true)
  })

  it('已经兜底过一次 → 不再触发（防循环）', () => {
    expect(shouldFallbackOnClaim({ ...base, alreadyUsed: true })).toBe(false)
  })

  it('全量不比当前面多 → 不触发（没有可换的东西）', () => {
    expect(shouldFallbackOnClaim({ ...base, fullCount: 3 })).toBe(false)
  })

  it('本轮有工具调用 → 不触发（模型其实用了工具，声称只是叙述）', () => {
    expect(shouldFallbackOnClaim({ ...base, toolCallsCount: 1 })).toBe(false)
  })

  it('full 模式 → 不触发', () => {
    expect(shouldFallbackOnClaim({ ...base, fallbackEnabled: false })).toBe(false)
  })

  it('文本不是声称 → 不触发', () => {
    expect(shouldFallbackOnClaim({ ...base, text: '我可以用工具查询天气。' })).toBe(false)
  })
})
