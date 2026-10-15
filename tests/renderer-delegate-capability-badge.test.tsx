// 委派能力徽标的界面契约（V4-Iter-142）——三态 + 未探 + 过期 + 探测中
// @vitest-environment jsdom
//
// 为什么值得挂：这一屏是"这台模型当不当得了管控者"唯一的用户可见出口，
// 而它的措辞纪律很具体 —— **fence_only 不能被写成"能用"**（决策①实测：放宽解析也只到 50%），
// unknown 不能被写成"这台不行"（那可能只是连不上）。两句都靠 DOM 断言钉住；颜色与排版仍归真机。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import React from 'react'
import { mountWithProviders } from './helpers/renderer'
import { DelegateCapabilityBadge } from '../src/renderer/src/modules/settings/DelegateCapabilityBadge'
import { zh } from '../src/renderer/src/i18n/zh'
import type { DelegateCapabilityView } from '../src/shared/delegate-capability'

const entry = (over: Partial<DelegateCapabilityView>): DelegateCapabilityView => ({
  key: 'p1::m1',
  providerId: 'p1',
  model: 'm1',
  capability: 'native_tools_ok',
  samples: 3,
  nativeHits: 3,
  digest: '',
  checkedAt: 1,
  stale: false,
  ...over
})

function mountBadge(props: Partial<React.ComponentProps<typeof DelegateCapabilityBadge>> = {}) {
  const onProbe = props.onProbe ?? vi.fn()
  mountWithProviders(
    <DelegateCapabilityBadge entry={'entry' in props ? props.entry : entry({})} probing={props.probing ?? false} onProbe={onProbe} />
  )
  return onProbe
}

describe('DelegateCapabilityBadge', () => {
  it('native_tools_ok：文案与 3/3 同时在场，点「探测」把回调传出去', () => {
    const onProbe = mountBadge({ entry: entry({ capability: 'native_tools_ok' }) })
    expect(screen.getByText(zh['provider.capNative'])).toBeTruthy()
    expect(screen.getByText(/3\/3/)).toBeTruthy()
    fireEvent.click(screen.getByText(zh['provider.capProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('fence_only：直说"当前用不了"，且不许出现"可当管控者"字样', () => {
    mountBadge({ entry: entry({ capability: 'fence_only', nativeHits: 0 }) })
    expect(screen.getByText(zh['provider.capFence'])).toBeTruthy()
    expect(screen.queryByText(zh['provider.capNative'])).toBeNull()
  })

  it('no_delegation：给出 0/3 的计数据，不写成"探测未完成"', () => {
    mountBadge({ entry: entry({ capability: 'no_delegation', nativeHits: 0 }) })
    expect(screen.getByText(zh['provider.capNone'])).toBeTruthy()
    expect(screen.getByText(/0\/3/)).toBeTruthy()
    expect(screen.queryByText(zh['provider.capUnknown'])).toBeNull()
  })

  it('unknown：不摆分数（没结论就别装作有数据），悬停说明讲清"未改写此前判定"', () => {
    mountBadge({ entry: entry({ capability: 'unknown', nativeHits: 2, samples: 3 }) })
    expect(screen.getByText(zh['provider.capUnknown'])).toBeTruthy()
    expect(screen.queryByText(/2\/3/)).toBeNull()
    expect(screen.getByText(zh['provider.capUnknown']).getAttribute('title')).toContain(zh['provider.capUnknownReason'])
  })

  it('stale：本地镜像换了摘要时追加"建议重探"', () => {
    mountBadge({ entry: entry({ stale: true }) })
    expect(screen.getByText(new RegExp(zh['provider.capStale'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()))).toBeTruthy()
  })

  it('没探过：只剩一个「探测」入口，不出任何判定文案', () => {
    const onProbe = mountBadge({ entry: null })
    for (const k of ['provider.capNative', 'provider.capFence', 'provider.capNone', 'provider.capUnknown'] as const) {
      expect(screen.queryByText(zh[k])).toBeNull()
    }
    fireEvent.click(screen.getByText(zh['provider.capProbe']))
    expect(onProbe).toHaveBeenCalledTimes(1)
  })

  it('探测中：按钮禁用、文案换成"探测中…"，连点不重复触发', () => {
    const onProbe = mountBadge({ probing: true })
    const btn = screen.getByText(zh['provider.capProbing']).closest('button')
    expect(btn?.disabled).toBe(true)
    fireEvent.click(btn!)
    expect(onProbe).not.toHaveBeenCalled()
  })
})
