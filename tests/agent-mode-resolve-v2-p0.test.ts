// resolveAgentMode 判定矩阵（v2 P0）：能力开关唯一口径是 `conversations.agent_mode`。
//
// 评审 M1 的原 bug：v1 在 `agentMode !== true` 后还有一条 `modelLabel.startsWith('agent:')`
// 兜底，于是用户显式关闭后，只要 model 还带历史前缀，重启/切会话就会被判回开启。
// 前缀已由迁移 v59 清掉，但判定层必须独立成立——这里锁死「显式关闭压过任何前缀」
// 以及「列值缺省 / 记录缺失」的行为，不依赖数据库。
import { describe, it, expect } from 'vitest'
import { resolveAgentMode, PENDING_AGENT_MODE_KEY } from '../src/renderer/src/modules/chat/agent-mode'

type Rec = { id: string; agentMode?: boolean; modelLabel?: string | null }
const recs = (list: Rec[]) => list

describe('resolveAgentMode：只认列值，前缀不参与', () => {
  it('列值 true（无前缀）→ 开启', () => {
    expect(resolveAgentMode('c1', recs([{ id: 'c1', agentMode: true, modelLabel: 'prov:m' }]), {})).toBe(true)
  })

  it('列值 false（无前缀）→ 关闭', () => {
    expect(resolveAgentMode('c1', recs([{ id: 'c1', agentMode: false, modelLabel: 'prov:m' }]), {})).toBe(false)
  })

  it('列值 false + 历史前缀 `agent:p:m` → 关闭（M1：显式关闭压过前缀）', () => {
    expect(
      resolveAgentMode('c1', recs([{ id: 'c1', agentMode: false, modelLabel: 'agent:prov:m' }]), {})
    ).toBe(false)
  })

  it('列值 true + 历史前缀 → 开启（前缀不影响开启结果）', () => {
    expect(
      resolveAgentMode('c1', recs([{ id: 'c1', agentMode: true, modelLabel: 'agent:prov:m' }]), {})
    ).toBe(true)
  })

  it('列值缺省（undefined，老记录形态）→ 关闭', () => {
    expect(resolveAgentMode('c1', recs([{ id: 'c1', modelLabel: 'prov:m' }]), {})).toBe(false)
  })

  it('列值缺省 + 历史前缀 → 关闭（不再按前缀默认开启）', () => {
    expect(resolveAgentMode('c1', recs([{ id: 'c1', modelLabel: 'agent:prov:m' }]), {})).toBe(false)
  })

  it('记录不在列表里 → 关闭（不猜、不向后端再要一次）', () => {
    expect(resolveAgentMode('missing', recs([{ id: 'c1', agentMode: true }]), {})).toBe(false)
  })

  it('本地乐观值优先于记录：显式关闭能压过库里的 true，显式开启能压过库里的 false', () => {
    const records = recs([{ id: 'c1', agentMode: true, modelLabel: 'prov:m' }])
    expect(resolveAgentMode('c1', records, { c1: false })).toBe(false)
    const records2 = recs([{ id: 'c1', agentMode: false, modelLabel: 'prov:m' }])
    expect(resolveAgentMode('c1', records2, { c1: true })).toBe(true)
  })

  it('尚未建会话（convId=null）只认 pending 暂存值，缺省关闭', () => {
    expect(resolveAgentMode(null, [], {})).toBe(false)
    expect(resolveAgentMode(null, [], { [PENDING_AGENT_MODE_KEY]: true })).toBe(true)
    expect(resolveAgentMode(null, [], { [PENDING_AGENT_MODE_KEY]: false })).toBe(false)
  })
})
