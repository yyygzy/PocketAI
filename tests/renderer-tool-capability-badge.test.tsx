// 工具调用徽标的界面契约（P0-4b）——四档 + 未测 + 过期 + 探测中 + 费用口径
// @vitest-environment jsdom
//
// 这一屏是"这台模型会不会调工具"唯一的用户可见出口，措辞纪律比排版更重要：
//  · unknown 不许写成"不会调工具"（那可能只是连不上/被跳过）；
//  · 已知不可用也不许省掉原因（围栏格式 vs 端点拒绝，是两种完全不同的事）；
//  · 可能不可用必须带计数据（2/3），不能凭一句话下结论；
//  · 按钮上必须写清"3 次请求，计入你的额度"——这是产品拍板的费用口径。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import React from 'react'
import { mountWithProviders } from './helpers/renderer'
import { ToolCapabilityBadge } from '../src/renderer/src/modules/settings/ToolCapabilityBadge'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ToolCapabilityView } from '../src/shared/tool-capability'

const entry = (over: Partial<ToolCapabilityView>): ToolCapabilityView => ({
  key: 'p1::m1',
  providerId: 'p1',
  model: 'm1',
  tier: 'usable',
  reason: '',
  samples: 3,
  nativeHits: 3,
  fenceHits: 0,
  digest: '',
  checkedAt: 1,
  stale: false,
  ...over
})

function mountBadge(props: Partial<React.ComponentProps<typeof ToolCapabilityBadge>> = {}) {
  const onProbe = props.onProbe ?? vi.fn()
  const onStopProbe = props.onStopProbe ?? vi.fn()
  mountWithProviders(
    <ToolCapabilityBadge
      entry={'entry' in props ? props.entry : entry({})}
      probing={props.probing ?? false}
      onProbe={onProbe}
      onStopProbe={onStopProbe}
    />
  )
  return { onProbe, onStopProbe }
}

describe('ToolCapabilityBadge —— 四档措辞', () => {
  it('usable：文案与 3/3 同时在场，点「测一下」把回调传出去', () => {
    const { onProbe } = mountBadge({ entry: entry({ tier: 'usable' }) })
    expect(screen.getByText(zh['provider.toolCapUsable'])).toBeTruthy()
    expect(screen.getByText(/3\/3/)).toBeTruthy()
    fireEvent.click(screen.getByText(zh['provider.toolCapProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('likely_unusable：给 2/3 的计数据，且不出现"会调工具"', () => {
    mountBadge({ entry: entry({ tier: 'likely_unusable', reason: 'partial_native_calls', nativeHits: 2 }) })
    expect(screen.getByText(zh['provider.toolCapLikely'])).toBeTruthy()
    expect(screen.getByText(/2\/3/)).toBeTruthy()
    expect(screen.queryByText(zh['provider.toolCapUsable'])).toBeNull()
  })

  it('known_unusable（围栏）：直说"不会调工具"，悬停里带围栏原因', () => {
    mountBadge({ entry: entry({ tier: 'known_unusable', reason: 'fence_only', nativeHits: 0, fenceHits: 3 }) })
    const label = screen.getByText(zh['provider.toolCapKnown'])
    expect(label.getAttribute('title')).toContain(zh['toolCap.reason.fence'])
    expect(screen.queryByText(zh['provider.toolCapUsable'])).toBeNull()
  })

  it('known_unusable（端点拒绝）：原因必须说"端点拒绝了 tools"，且不摆 0/3 这种假样本', () => {
    mountBadge({ entry: entry({ tier: 'known_unusable', reason: 'tools_rejected', samples: 0, nativeHits: 0 }) })
    expect(screen.getByText(zh['provider.toolCapKnown']).getAttribute('title')).toContain(
      zh['toolCap.reason.rejected']
    )
    expect(screen.queryByText(/0\/0/)).toBeNull()
  })

  it('unknown：不摆分数，悬停讲清失败原因（不许演成"这台不行"）', () => {
    mountBadge({ entry: entry({ tier: 'unknown', reason: 'some_requests_failed', nativeHits: 2, samples: 3 }) })
    expect(screen.getByText(zh['provider.toolCapUnknown'])).toBeTruthy()
    expect(screen.queryByText(/2\/3/)).toBeNull()
    expect(screen.getByText(zh['provider.toolCapUnknown']).getAttribute('title')).toContain(
      zh['toolCap.reason.someRequestsFailed']
    )
    expect(screen.queryByText(zh['provider.toolCapKnown'])).toBeNull()
  })

  it('stale：本地镜像换了摘要时追加"建议重测"', () => {
    mountBadge({ entry: entry({ stale: true }) })
    const re = new RegExp(zh['provider.toolCapStale'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim())
    expect(screen.getByText(re)).toBeTruthy()
  })

  it('没测过：只剩一个「测一下」入口，不出任何判定文案', () => {
    const { onProbe } = mountBadge({ entry: null })
    for (const k of ['provider.toolCapUsable', 'provider.toolCapLikely', 'provider.toolCapKnown', 'provider.toolCapUnknown'] as const) {
      expect(screen.queryByText(zh[k])).toBeNull()
    }
    fireEvent.click(screen.getByText(zh['provider.toolCapProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })
})

describe('ToolCapabilityBadge —— 探测中与费用口径', () => {
  it('「测一下」的 title 必须写明 3 次请求计入额度（不是只藏在设置页提示里）', () => {
    mountBadge({ entry: null })
    const btn = screen.getByText(zh['provider.toolCapProbe']).closest('button')
    expect(btn?.getAttribute('title')).toContain(zh['provider.toolCapFee'])
  })

  it('探测中：按钮禁用、文案换成"测试中…"，连点不重复触发（避免重复计费）', () => {
    const { onProbe } = mountBadge({ probing: true })
    const btn = screen.getByText(zh['provider.toolCapProbing']).closest('button')
    expect(btn?.disabled).toBe(true)
    fireEvent.click(btn!)
    expect(onProbe).not.toHaveBeenCalled()
  })

  it('探测中给一颗「停止」：文案与 title 取自字典，点它把中止权交出去', () => {
    const { onStopProbe } = mountBadge({ probing: true })
    const stop = screen.getByTestId('tool-cap-stop')
    expect(stop.textContent).toBe(zh['provider.toolCapStop'])
    expect(stop.getAttribute('title')).toBe(zh['provider.toolCapStopHint'])
    fireEvent.click(stop)
    expect(onStopProbe).toHaveBeenCalledTimes(1)
  })

  it('反向对照：不在探测时「停止」不存在（它不是常驻按钮）', () => {
    mountBadge({ entry: entry({ tier: 'usable' }) })
    expect(screen.queryByTestId('tool-cap-stop')).toBeNull()
  })
})
