// 默认服务商选取规则（对话页自动回填 targets 的那一步）
//
// 钉的是这条真实故障：provider 是 enabled 的、但模型列表是空的（新建后没拉模型，
// 或在设置里把已缓存模型逐个删完并保存），旧代码 `filter(enabled)[0]` 会选中它，
// 于是 model='' → 发送永久禁用 → 提示还说"请先配置服务商"（说谎）。
import { describe, it, expect } from 'vitest'
import type { ProviderRecord } from '../src/shared/types'
import { hasUsableModel, isTargetStillValid, pickDefaultProvider } from '../src/renderer/src/utils/provider-pick'

const p = (id: string, over: Partial<ProviderRecord> = {}): ProviderRecord =>
  ({
    id,
    name: id.toUpperCase(),
    enabled: true,
    models: ['gpt-x'],
    ...over
  }) as unknown as ProviderRecord

describe('hasUsableModel', () => {
  it('启用且有模型才算能用；停用或模型列表为空都不算', () => {
    expect(hasUsableModel(p('a'))).toBe(true)
    expect(hasUsableModel(p('b', { models: [] }))).toBe(false)
    expect(hasUsableModel(p('c', { enabled: false }))).toBe(false)
    expect(hasUsableModel(undefined)).toBe(false)
    // 缺 models 字段（老数据/脏记录）不能把界面带崩
    expect(hasUsableModel(p('d', { models: undefined as unknown as string[] }))).toBe(false)
  })
})

describe('pickDefaultProvider', () => {
  it('记住的那家仍可用 → 优先它', () => {
    const list = [p('a'), p('b')]
    expect(pickDefaultProvider(list, 'b')?.id).toBe('b')
  })

  it('记住的那家被停用 → 回退，且跳过"启用但没模型"的那家', () => {
    const list = [p('gone', { enabled: false }), p('empty', { models: [] }), p('good')]
    expect(pickDefaultProvider(list, 'gone')?.id).toBe('good')
  })

  it('没记住过 → 选第一家有模型的（不是第一家启用的）', () => {
    const list = [p('empty', { models: [] }), p('good')]
    expect(pickDefaultProvider(list)?.id).toBe('good')
    expect(pickDefaultProvider(list, null)?.id).toBe('good')
  })

  it('一家有模型的都没有 → 仍返回第一家启用的（让 UI 能说"去拉取模型"，而不是假装没配服务商）', () => {
    const list = [p('e1', { models: [] }), p('e2', { models: [] })]
    expect(pickDefaultProvider(list)?.id).toBe('e1')
  })

  it('没有任何启用的服务商 → null', () => {
    expect(pickDefaultProvider([p('off', { enabled: false })], 'off')).toBeNull()
    expect(pickDefaultProvider([])).toBeNull()
  })
})

describe('isTargetStillValid — 切回模块时要不要重挑', () => {
  const list = [p('glm', { models: ['glm-4.6'] }), p('empty', { models: [] }), p('off', { models: ['x'], enabled: false })]

  it('服务商还在、仍启用、模型仍在列表里 → 有效，别动用户手选的模型', () => {
    expect(isTargetStillValid({ providerId: 'glm', model: 'glm-4.6' }, list)).toBe(true)
  })

  it('模型被删出列表 / 服务商被停用 / 服务商消失 → 无效，要重挑', () => {
    expect(isTargetStillValid({ providerId: 'glm', model: 'glm-3-turbo' }, list)).toBe(false)
    expect(isTargetStillValid({ providerId: 'off', model: 'x' }, list)).toBe(false)
    expect(isTargetStillValid({ providerId: 'gone', model: 'glm-4.6' }, list)).toBe(false)
  })

  it('model 是空串一律算无效（正是"上次那家没模型、刚去拉回来"的情形）', () => {
    expect(isTargetStillValid({ providerId: 'glm', model: '' }, list)).toBe(false)
    expect(isTargetStillValid({ providerId: 'empty', model: '' }, list)).toBe(false)
    expect(isTargetStillValid(undefined, list)).toBe(false)
  })
})
